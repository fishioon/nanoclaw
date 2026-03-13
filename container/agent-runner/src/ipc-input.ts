import fs from 'fs';
import path from 'path';

export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = ImageContentBlock | TextContentBlock;

export interface IpcTextInput {
  type: 'message';
  text: string;
}

export interface IpcTextIpcContentBlock {
  type: 'text';
  text: string;
}

export interface IpcImagePathContentBlock {
  type: 'image_path';
  path: string;
  mediaType: string;
}

export type IpcMultimodalContentBlock =
  | IpcTextIpcContentBlock
  | IpcImagePathContentBlock;

export interface IpcMultimodalInput {
  type: 'multimodal';
  content: IpcMultimodalContentBlock[];
}

export type IpcInput = IpcTextInput | IpcMultimodalInput;

export type LogFn = (message: string) => void;

export function describeIpcInput(input: IpcInput): string {
  if (input.type === 'message') {
    return `text(${input.text.length} chars)`;
  }
  const blockSummary = input.content.map((block) => {
    if (block.type === 'text') return `text(${block.text.length})`;
    return `image(${block.path})`;
  });
  return `multimodal(${blockSummary.join(', ')})`;
}

export function resolveGroupPath(
  groupWorkspaceDir: string,
  relativePath: string,
): string | null {
  const resolved = path.resolve(groupWorkspaceDir, relativePath);
  const relative = path.relative(groupWorkspaceDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

export function loadMultimodalContent(
  blocks: IpcMultimodalContentBlock[],
  groupWorkspaceDir: string,
  log: LogFn,
): ContentBlock[] {
  const content: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) content.push({ type: 'text', text: block.text });
      continue;
    }

    const mediaType =
      typeof block.mediaType === 'string' ? block.mediaType.trim() : '';
    if (!mediaType.startsWith('image/')) {
      log(`Ignoring unsupported multimodal media type: ${block.mediaType}`);
      continue;
    }

    const filePath = resolveGroupPath(groupWorkspaceDir, block.path);
    if (!filePath) {
      log(`Ignoring multimodal image outside group workspace: ${block.path}`);
      continue;
    }

    try {
      const data = fs.readFileSync(filePath).toString('base64');
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    } catch (err) {
      log(
        `Failed to load multimodal image ${block.path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return content;
}
