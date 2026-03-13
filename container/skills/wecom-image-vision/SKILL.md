---
name: wecom-image-vision
description: When a conversation contains a `[WeCom image] {...}` marker with an `sdkFileId` and the current task clearly depends on seeing the image, download it through the configured WeCom API, save it under the current group, and inject it back into the active Claude session as a multimodal follow-up before answering.
allowed-tools: Bash(node:*)
---

# WeCom Image Vision

Use this skill only when both conditions are true:

1. The conversation includes a WeCom image marker such as:

```text
[WeCom image] {"sdkFileId":"file-123","filename":"photo.jpg"}
```

2. The current task actually requires visual inspection of the image.

Do not fetch images by default. If the user is only asking about text around the image, metadata, or something that can be answered without opening the image, skip this skill.

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

## Good triggers

- "What is shown in that picture?"
- "Read the chart in the image"
- "Describe the screenshot"
- "Check whether the product label says 128GB or 256GB"

## Skip triggers

- The request can be answered from surrounding text alone
- The user did not ask about the image and the image is not necessary to complete the task
- The image marker is present only as background context

## Failure handling

- If the script fails, explain that the WeCom image could not be fetched and fall back to any non-visual metadata already present in the conversation.
- If `NANOCLAW_WECOM_API_BASE_URL` is missing, report that WeCom runtime image access is not configured in this NanoClaw install.
