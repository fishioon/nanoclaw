#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const GROUP_DIR = '/workspace/group';
const IPC_INPUT_DIR = '/workspace/ipc/input';

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
  console.error(message);
  process.exit(1);
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

function buildInstructionText(caption, note, relativePath) {
  const parts = [
    'A WeCom image referenced earlier in this conversation has been downloaded and is attached below.',
    `Local path: ${relativePath}`,
    'Use this image to answer the current user request.',
  ];
  if (caption) parts.push(`Original caption: ${caption}`);
  if (note) parts.push(`Operator note: ${note}`);
  return parts.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdkFileId = (args['sdk-file-id'] || '').trim();
  if (!sdkFileId) fail('Missing required --sdk-file-id');

  const baseUrl = (process.env.NANOCLAW_WECOM_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) fail('NANOCLAW_WECOM_API_BASE_URL is not configured');

  const requestedName = sanitizeFilename(args.filename || `wecom-${sdkFileId}.jpg`);
  const downloadUrl = new URL('/api/messages/download', `${baseUrl}/`);
  downloadUrl.searchParams.set('sdkFileId', sdkFileId);
  downloadUrl.searchParams.set('filename', requestedName);

  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Accept: 'image/*,application/octet-stream;q=0.8',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    fail(`Failed to download WeCom image (${response.status}): ${body || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) fail('Downloaded WeCom image is empty');

  const detected = sniffImageType(buffer);
  if (!detected) fail('Downloaded WeCom attachment is not a supported image type');

  const attachmentsDir = path.join(GROUP_DIR, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  const timestamp = Date.now();
  const fileBase = sanitizeFilename(path.parse(requestedName).name || `wecom-${sdkFileId}`);
  const filename = `${fileBase}-${timestamp}${detected.extension}`;
  const fullPath = path.join(attachmentsDir, filename);
  fs.writeFileSync(fullPath, buffer);

  const relativePath = path.posix.join('attachments', filename);
  const note = (args.note || '').trim();
  const caption = (args.caption || '').trim();

  const payload = {
    type: 'multimodal',
    content: [
      {
        type: 'text',
        text: buildInstructionText(caption, note, relativePath),
      },
      {
        type: 'image_path',
        path: relativePath,
        mediaType: detected.mediaType,
      },
    ],
  };

  const ipcFile = path.join(
    IPC_INPUT_DIR,
    `${timestamp}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(ipcFile, JSON.stringify(payload, null, 2));

  process.stdout.write(
    JSON.stringify(
      {
        sdkFileId,
        relativePath,
        mediaType: detected.mediaType,
        bytes: buffer.length,
        ipcFile,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
