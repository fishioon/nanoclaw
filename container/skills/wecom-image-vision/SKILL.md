---
name: wecom-image-vision
description: Analyze Enterprise WeCom image attachments at runtime when the conversation includes a `[WeCom image] {...}` marker with an `sdkFileId`. Download the image through the configured WeCom API, save it under the current group, and inject it back into the active Claude session as a multimodal follow-up before answering.
allowed-tools: Bash(node:*)
---

# WeCom Image Vision

Use this skill when the conversation includes a WeCom image marker such as:

```text
[WeCom image] {"sdkFileId":"file-123","filename":"photo.jpg"}
```

## Workflow

1. Extract the `sdkFileId` from the marker.
2. Run the helper script:

```bash
node ~/.claude/skills/wecom-image-vision/scripts/fetch-wecom-image.mjs \
  --sdk-file-id "file-123" \
  --filename "photo.jpg"
```

Optional flags:

```bash
--caption "original caption text"
--note "Focus on the product label and summarize it for the current request."
```

3. The script downloads the image from `NANOCLAW_WECOM_API_BASE_URL`, saves it into `attachments/`, and writes a multimodal follow-up file into `/workspace/ipc/input/`.
4. Do not guess image contents before the follow-up arrives. Continue only after the image has been injected into the current session.
5. If multiple WeCom image markers exist, fetch only the image or images relevant to the current request.

## Failure handling

- If the script fails, explain that the WeCom image could not be fetched and fall back to any non-visual metadata already present in the conversation.
- If `NANOCLAW_WECOM_API_BASE_URL` is missing, report that WeCom runtime image access is not configured in this NanoClaw install.
