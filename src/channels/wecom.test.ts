import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSISTANT_NAME } from '../config.js';
import { RegisteredGroup } from '../types.js';
import { WeComChannel } from './wecom.js';

describe('WeComChannel', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('auto-registers chats and forwards inbound messages', () => {
    const groups: Record<string, RegisteredGroup> = {};
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const registerGroup = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });

    const channel = new WeComChannel('https://example.com', '', 1000, new Set(), {
      onMessage,
      onChatMetadata,
      registeredGroups: () => groups,
      registerGroup,
    });

    (channel as any).processItem({
      seq: 1,
      msgid: 'outer-1',
      chat_msg: {
        msgid: 'msg-1',
        msgtime: 1700000000000,
        from: 'alice',
        roomid: 'room-1',
        msgtype: 'text',
        text: { content: `hello @${ASSISTANT_NAME}` },
      },
    });

    expect(registerGroup).toHaveBeenCalledWith(
      'wc:room-1',
      expect.objectContaining({
        name: 'room-1',
        requiresTrigger: true,
        trigger: `@${ASSISTANT_NAME}`,
      }),
    );
    expect(onChatMetadata).toHaveBeenCalledWith(
      'wc:room-1',
      '2023-11-14T22:13:20.000Z',
      'room-1',
      'wecom',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'wc:room-1',
      expect.objectContaining({
        id: 'msg-1',
        sender: 'alice',
        content: `@${ASSISTANT_NAME} hello @${ASSISTANT_NAME}`,
      }),
    );
  });

  it('formats image messages with a stable sdkFileId marker', () => {
    const onMessage = vi.fn();
    const channel = new WeComChannel('https://example.com', '', 1000, new Set(), {
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    (channel as any).processItem({
      seq: 2,
      msgid: 'outer-2',
      chat_msg: {
        msgid: 'msg-2',
        msgtime: 1700000000000,
        from: 'alice',
        msgtype: 'image',
        image: { sdkfileid: 'file-1' },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(
      'wc:alice',
      expect.objectContaining({
        content:
          '[WeCom image] ' +
          JSON.stringify({
            sdkFileId: 'file-1',
          }),
      }),
    );
  });

  it('sends text messages through worktool API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
    } as Response);

    const channel = new WeComChannel('https://example.com/', 'secret', 1000, new Set(), {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    await channel.sendMessage('wc:room-1', '  hello world  ');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/worktool/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
        },
        body: JSON.stringify({
          socketType: 2,
          list: [
            {
              type: 203,
              chatId: 'room-1',
              receivedContent: 'hello world',
            },
          ],
        }),
      }),
    );
  });
});
