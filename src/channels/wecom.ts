import { ASSISTANT_NAME, POLL_INTERVAL, TRIGGER_PATTERN } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface ChatMessage {
  msgid: string;
  msgtime: number;
  from: string;
  roomid?: string;
  msgtype: string;
  text?: { content?: string };
  [key: string]: unknown;
}

interface ArchiveItem {
  seq: number;
  msgid: string;
  chat_msg?: ChatMessage;
}

interface ArchiveResponse {
  errcode: number;
  errmsg: string;
  chatdata_list?: ArchiveItem[];
}

interface WeComImagePayload {
  sdkfileid?: unknown;
  sdkFileId?: unknown;
  filename?: unknown;
  fileName?: unknown;
}

const ROUTER_STATE_SEQ_KEY = 'wecom_seq';
const DEFAULT_PULL_COUNT = 100;
const MAX_FOLDER_LENGTH = 64;
const WECOM_SOCKET_TYPE = 2;
const WECOM_TEXT_TYPE = 203;

function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

function parseNumberOrDefault(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseIgnoredSenders(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,;]+/u)
      .map((value) => normalizeSender(value))
      .filter(Boolean),
  );
}

function toIsoTimestamp(raw: number | undefined): string {
  if (!Number.isFinite(raw)) return new Date().toISOString();
  const value = raw as number;
  const millis = value < 1e12 ? value * 1000 : value;
  const timestamp = new Date(millis);
  if (Number.isNaN(timestamp.getTime())) return new Date().toISOString();
  return timestamp.toISOString();
}

function sanitizeFolderSeed(raw: string): string {
  const stripped = raw.replace(/^wc:/iu, '').trim().toLowerCase();
  const normalized = stripped
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '');
  const cleaned = normalized
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/_{2,}/gu, '_')
    .replace(/^[_-]+/u, '')
    .replace(/[_-]+$/u, '');
  let folder = cleaned || 'wc_group';
  if (folder.toLowerCase() === 'global') folder = 'wc_global';
  if (folder.length > MAX_FOLDER_LENGTH) {
    folder = folder.slice(0, MAX_FOLDER_LENGTH);
  }
  return folder;
}

function uniqueFolder(base: string, existingFolders: Set<string>): string {
  if (!existingFolders.has(base)) return base;
  let i = 2;
  while (true) {
    const suffix = `_${i}`;
    const head = base.slice(0, MAX_FOLDER_LENGTH - suffix.length);
    const candidate = `${head}${suffix}`;
    if (!existingFolders.has(candidate)) return candidate;
    i += 1;
  }
}

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function extractWeComImageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;

  const image = payload as WeComImagePayload;
  const sdkFileId = getTrimmedString(image.sdkFileId ?? image.sdkfileid);
  if (!sdkFileId) return null;

  const filename = getTrimmedString(image.fileName ?? image.filename);
  const content: Record<string, string> = { sdkFileId };
  if (filename) content.filename = filename;

  return `[WeCom image] ${JSON.stringify(content)}`;
}

function extractContent(msg: ChatMessage): string {
  if (msg.msgtype === 'text') {
    return msg.text?.content?.trim() || '';
  }

  const payload = msg[msg.msgtype];
  if (msg.msgtype === 'image') {
    const imageContent = extractWeComImageContent(payload);
    if (imageContent) return imageContent;
  }

  return `[WeCom message: ${msg.msgtype}] ${JSON.stringify(payload)}`;
}

export class WeComChannel implements Channel {
  name = 'wecom';

  private apiUrl: string;
  private authToken: string;
  private pollInterval: number;
  private ignoredSenders: Set<string>;
  private opts: ChannelOpts;

  private seq = 0;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    apiUrl: string,
    authToken: string,
    pollInterval: number,
    ignoredSenders: Set<string>,
    opts: ChannelOpts,
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.authToken = authToken;
    this.pollInterval = pollInterval;
    this.ignoredSenders = ignoredSenders;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const saved = getRouterState(ROUTER_STATE_SEQ_KEY);
    if (saved) this.seq = parseInt(saved, 10) || 0;

    this.polling = true;
    this.schedulePoll();

    logger.info(
      {
        apiUrl: this.apiUrl,
        pollInterval: this.pollInterval,
        seq: this.seq,
        ignoredSenders: this.ignoredSenders.size,
      },
      'WeCom channel connected',
    );
  }

  private schedulePoll(): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      await this.pullMessages();
    } catch (err) {
      logger.error({ err }, 'WeCom poll error');
    }

    this.schedulePoll();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    return headers;
  }

  private async pullMessages(): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/api/messages/pull`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ seq: this.seq, count: DEFAULT_PULL_COUNT }),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'WeCom pull returned non-OK status');
      return;
    }

    const data = (await resp.json()) as ArchiveResponse;
    if (data.errcode !== 0) {
      logger.warn(
        { errcode: data.errcode, errmsg: data.errmsg },
        'WeCom pull API error',
      );
      return;
    }

    const items = data.chatdata_list;
    if (!items || items.length === 0) return;

    let maxSeq = this.seq;
    for (const item of items.sort((a, b) => a.seq - b.seq)) {
      if (item.seq > maxSeq) maxSeq = item.seq;
      this.processItem(item);
    }

    if (maxSeq > this.seq) {
      this.seq = maxSeq;
      setRouterState(ROUTER_STATE_SEQ_KEY, String(this.seq));
    }
  }

  private processItem(item: ArchiveItem): void {
    const msg = item.chat_msg;
    if (!msg?.from) return;

    if (this.ignoredSenders.has(normalizeSender(msg.from))) {
      return;
    }

    const isGroup = Boolean(msg.roomid);
    const chatJid = msg.roomid ? `wc:${msg.roomid}` : `wc:${msg.from}`;
    const timestamp = toIsoTimestamp(msg.msgtime);
    const displayName = (isGroup ? msg.roomid : msg.from)?.trim() || chatJid;

    this.maybeAutoRegisterChat(chatJid, displayName, isGroup);

    let content = extractContent(msg);
    if (!content) return;
    if (
      msg.msgtype === 'text' &&
      content.includes(`@${ASSISTANT_NAME}`) &&
      !TRIGGER_PATTERN.test(content.trim())
    ) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      displayName,
      'wecom',
      isGroup,
    );

    const inbound: NewMessage = {
      id: msg.msgid || item.msgid || `wecom-${item.seq}`,
      chat_jid: chatJid,
      sender: msg.from,
      sender_name: msg.from,
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, inbound);
  }

  private maybeAutoRegisterChat(
    chatJid: string,
    name: string,
    isGroup: boolean,
  ): void {
    if (!this.opts.registerGroup) return;

    const groups = this.opts.registeredGroups();
    const existing = groups[chatJid];
    if (existing) {
      if (!isGroup && existing.requiresTrigger !== false) {
        this.opts.registerGroup(chatJid, {
          ...existing,
          requiresTrigger: false,
        });
      }
      return;
    }

    const existingFolders = new Set(Object.values(groups).map((g) => g.folder));
    const baseFolder = isGroup
      ? sanitizeFolderSeed(`wc_${name}`)
      : sanitizeFolderSeed(`wc_dm_${name}`);
    const folder = uniqueFolder(baseFolder, existingFolders);
    const group: RegisteredGroup = {
      name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: isGroup,
    };

    this.opts.registerGroup(chatJid, group);
    logger.info({ chatJid, folder, isGroup }, 'WeCom chat auto-registered');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;

    const chatId = jid.replace(/^wc:/u, '');

    try {
      const resp = await fetch(`${this.apiUrl}/api/worktool/send`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          socketType: WECOM_SOCKET_TYPE,
          list: [
            {
              type: WECOM_TEXT_TYPE,
              chatId,
              receivedContent: content,
            },
          ],
        }),
      });

      if (!resp.ok) {
        logger.error(
          { jid, status: resp.status },
          'WeCom send returned non-OK status',
        );
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WeCom message');
    }
  }

  isConnected(): boolean {
    return this.polling;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wc:');
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('WeCom channel stopped');
  }
}

function createWeComChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile([
    'WECOM_API_URL',
    'WECOM_AUTH_TOKEN',
    'WECOM_POLL_INTERVAL',
    'WECOM_IGNORED_SENDERS',
  ]);

  const apiUrl = (process.env.WECOM_API_URL || env.WECOM_API_URL || '').trim();
  if (!apiUrl) return null;

  const authToken = (
    process.env.WECOM_AUTH_TOKEN ||
    env.WECOM_AUTH_TOKEN ||
    ''
  ).trim();
  const pollInterval = parseNumberOrDefault(
    process.env.WECOM_POLL_INTERVAL || env.WECOM_POLL_INTERVAL,
    POLL_INTERVAL,
  );
  const ignoredSenders = parseIgnoredSenders(
    process.env.WECOM_IGNORED_SENDERS || env.WECOM_IGNORED_SENDERS,
  );

  return new WeComChannel(
    apiUrl,
    authToken,
    pollInterval,
    ignoredSenders,
    opts,
  );
}

registerChannel('wecom', createWeComChannel);
