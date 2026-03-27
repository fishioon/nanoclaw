#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const GROUP_DIR = '/workspace/group';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const LOG_DIR = path.join(GROUP_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'wecom-image-vision.log');
const MAX_DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1500;

function appendLogLine(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best-effort only. stderr remains the primary fallback.
  }
}

function log(message, extra) {
  const line =
    extra === undefined
      ? `[wecom-image-vision] ${message}`
      : `[wecom-image-vision] ${message}: ${extra}`;
  appendLogLine(line);
  if (extra === undefined) {
    console.error(line);
    return;
  }
  console.error(line);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function fail(message) {
  appendLogLine(`[wecom-image-vision] FAIL: ${message}`);
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSdkFileId(value) {
  if (!value) return '(empty)';
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)} (len=${value.length})`;
}

function previewText(value, limit = 200) {
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function sniffImageType(buffer) {
  if (buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff) {
    return { mediaType: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47) {
    return { mediaType: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { mediaType: 'image/gif', extension: '.gif' };
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mediaType: 'image/webp', extension: '.webp' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return { mediaType: 'image/bmp', extension: '.bmp' };
  }
  return null;
}

function sanitizeFilename(name) {
  const base = path.basename(name || 'image');
  return base.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function buildContextMessage(caption, note) {
  const parts = [];
  if (caption) parts.push(`Original caption: ${caption}`);
  if (note) parts.push(`Operator note: ${note}`);
  if (parts.length === 0) return null;
  return parts.join('\n');
}

function shouldRetryDownload(status, body) {
  if (status >= 500) return true;
  if (!body) return false;
  return body.includes('wecom sdk error');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdkFileId = (args['sdk-file-id'] || '').trim();
  if (!sdkFileId) fail('Missing required --sdk-file-id');

  const baseUrl = (process.env.NANOCLAW_WECOM_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) fail('NANOCLAW_WECOM_API_BASE_URL is not configured');

  const requestedName = sanitizeFilename(args.filename || `wecom-${sdkFileId}.jpg`);
  const downloadUrl = new URL('/api/messages/download', `${baseUrl}/`);
  const downloadPayload = {
    sdkFileId,
    filename: requestedName,
  };

  log('Download request prepared', JSON.stringify({
    baseUrl,
    pathname: downloadUrl.pathname,
    sdkFileId: redactSdkFileId(sdkFileId),
    filename: requestedName,
    method: 'POST',
  }));

  let buffer = null;
  let lastErrorMessage = '';

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(downloadUrl, {
        method: 'POST',
        headers: {
          Accept: 'image/*,application/octet-stream;q=0.8',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(downloadPayload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErrorMessage = message;
      log(
        'Download request failed',
        JSON.stringify({ attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS, message }),
      );
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      fail(`Failed to download WeCom image: ${message}`);
    }

    log('Download response received', JSON.stringify({
      attempt,
      maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') || '',
      contentLength: response.headers.get('content-length') || '',
    }));

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      lastErrorMessage = body || response.statusText;
      log(
        'Download failed body preview',
        JSON.stringify({
          attempt,
          maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
          body: previewText(lastErrorMessage),
        }),
      );
      if (attempt < MAX_DOWNLOAD_ATTEMPTS && shouldRetryDownload(response.status, body)) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      fail(`Failed to download WeCom image (${response.status}): ${lastErrorMessage}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    break;
  }

  if (!buffer) fail(`Failed to download WeCom image: ${lastErrorMessage || 'unknown error'}`);
  if (buffer.length === 0) fail('Downloaded WeCom image is empty');

  const detected = sniffImageType(buffer);
  if (!detected) fail('Downloaded WeCom attachment is not a supported image type');

  const mediaDir = path.join(GROUP_DIR, 'incoming-media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const timestamp = Date.now();
  const fileBase = sanitizeFilename(
    path.parse(requestedName).name || `wecom-${sdkFileId}`,
  );
  const suffix = Math.random().toString(36).slice(2, 8);
  const filename = `${timestamp}-${suffix}-${fileBase}${detected.extension}`;
  const fullPath = path.join(mediaDir, filename);
  fs.writeFileSync(fullPath, buffer);
  log('Image saved locally', JSON.stringify({
    fullPath,
    bytes: buffer.length,
    mediaType: detected.mediaType,
  }));

  const relativePath = path.posix.join('incoming-media', filename);
  const note = (args.note || '').trim();
  const caption = (args.caption || '').trim();

  const ipcBaseName = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMessage = buildContextMessage(caption, note);
  const multimodalPayload = {
    type: 'multimodal',
    content: [
      ...(contextMessage ? [{ type: 'text', text: contextMessage }] : []),
      {
        type: 'image_path',
        path: relativePath,
        mediaType: detected.mediaType,
      },
    ],
  };
  const imageIpcFile = path.join(IPC_INPUT_DIR, `${ipcBaseName}.00-image.json`);
  fs.writeFileSync(imageIpcFile, JSON.stringify(multimodalPayload, null, 2));
  log('Multimodal IPC message written', imageIpcFile);

  process.stdout.write(
    JSON.stringify(
      {
        sdkFileId,
        relativePath,
        mediaType: detected.mediaType,
        bytes: buffer.length,
        imageIpcFile,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  appendLogLine(`[wecom-image-vision] UNCAUGHT: ${message}`);
  fail(message);
});
