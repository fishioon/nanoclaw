import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeIpcInput,
  loadMultimodalContent,
  resolveGroupPath,
} from './ipc-input.js';

describe('ipc-input helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('describes text and multimodal follow-up inputs', () => {
    expect(describeIpcInput({ type: 'message', text: 'hello' })).toBe(
      'text(5 chars)',
    );
    expect(
      describeIpcInput({
        type: 'multimodal',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image_path',
            path: 'attachments/a.jpg',
            mediaType: 'image/jpeg',
          },
        ],
      }),
    ).toBe('multimodal(text(4), image(attachments/a.jpg))');
  });

  it('keeps multimodal image paths inside the group workspace', () => {
    const groupDir = '/workspace/group';
    expect(resolveGroupPath(groupDir, 'attachments/a.jpg')).toBe(
      '/workspace/group/attachments/a.jpg',
    );
    expect(resolveGroupPath(groupDir, '../secrets.txt')).toBeNull();
    expect(resolveGroupPath(groupDir, '/tmp/outside.jpg')).toBeNull();
  });

  it('loads text and image blocks from a multimodal IPC payload', () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-'));
    const imagePath = path.join(groupDir, 'attachments', 'photo.jpg');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from('image-bytes'));

    const log = vi.fn();
    const content = loadMultimodalContent(
      [
        { type: 'text', text: 'Inspect this image.' },
        {
          type: 'image_path',
          path: 'attachments/photo.jpg',
          mediaType: 'image/jpeg',
        },
      ],
      groupDir,
      log,
    );

    expect(content).toEqual([
      { type: 'text', text: 'Inspect this image.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from('image-bytes').toString('base64'),
        },
      },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs and skips unsupported or unsafe multimodal image blocks', () => {
    const log = vi.fn();

    const content = loadMultimodalContent(
      [
        {
          type: 'image_path',
          path: 'attachments/photo.txt',
          mediaType: 'text/plain',
        },
        {
          type: 'image_path',
          path: '../outside.jpg',
          mediaType: 'image/jpeg',
        },
      ],
      '/workspace/group',
      log,
    );

    expect(content).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
