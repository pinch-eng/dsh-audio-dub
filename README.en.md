# dsh-audio-dub

[中文](README.md)

DSH dubbing plugin — dub a video or audio file into another language while keeping the original speaker's voice (AI voice cloning). Turn a Chinese video into an English one in a single tool call, or the other way round.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-lightgrey)](https://github.com/topics/dsh-plugin)

```
You:   dub ./demo.mp4 into English
Agent: [dub_media] Job 8f3a… — completed
       zh → en · duration 154s · cost $1.28
       Download: https://…/dubbed.mp4
```

## Motivation

Agents handle text translation well, but "make an English version of this video" falls outside the toolchain: either you upload it to a web app by hand, or you wire up ffmpeg + ASR + translation + TTS + alignment yourself.

This plugin collapses that into one tool call: **give it a local path or a direct media URL, get back a finished dub**. Transcription, translation, voice cloning and timing all happen server-side; the agent just waits for the result.

## Install

```bash
npm install dsh-audio-dub
```

Add to `cordis.yml`:

```yaml
- id: audio-dub
  name: 'dsh-audio-dub'
```

Then set an API key (create one at [portal.startpinch.com](https://portal.startpinch.com/dashboard/api-keys); it looks like `pk_…`):

```bash
export PINCH_API_KEY=pk_xxx
```

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | `process.env.PINCH_API_KEY` | API key. **Prefer the environment variable** over writing it into `cordis.yml` |
| `baseUrl` | string | `https://portal.startpinch.com` | Override for self-hosted or staging |
| `pollIntervalMs` | integer | `15000` | Status poll interval while waiting; floor 5000 |

## Tools

### `dub_media`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✅ | Local file path (`./talk.mp4`) or a direct link to a media file. Page URLs (YouTube, Bilibili, social posts) are **not** media files and are rejected |
| `target_lang` | string | ✅ | Language to dub into — see the table below |
| `source_lang` | string | | Spoken language of the source. Default `auto` |
| `reduce_accent` | boolean | | More native-sounding target pronunciation, at a small cost to voice similarity. Defaults on for non-English targets |
| `wait` | boolean | | Wait for the result. Default `true` |
| `wait_seconds` | integer | | Wait budget; default 600, max 1800. Rule of thumb: allow 1–2× the media duration |

Local files are streamed to a presigned upload target before the job is submitted — a 2 GB mp4 never lands in memory.

Running out of wait budget is not a failure: the job continues server-side, and the returned `job_id` can be handed to `dub_status`.

### `dub_status`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | ✅ | Job id returned by `dub_media` |
| `wait` | boolean | | Wait for completion instead of returning the current status. Default `false` |
| `wait_seconds` | integer | | As above |

### `dub_languages`

No parameters. Local lookup — no network call, no cost.

## Supported languages

| Code | Language | Code | Language |
|---|---|---|---|
| `zh` | Chinese | `pt` | Portuguese |
| `en` | English | `ru` | Russian |
| `es` | Spanish | `ja` | Japanese |
| `fr` | French | `ko` | Korean |
| `de` | German | `it` | Italian |

The source language may additionally be `auto`.

## Pricing and limits

- **$0.50 per minute** of media
- Max **60 minutes** and **2 GB** per file
- Download links are valid for 48 hours; call `dub_status` again for a fresh one

On an empty balance the tool returns `insufficient_balance` together with the top-up URL, so the agent can tell you exactly what to do.

## Security model

- **Credentials stay in the header**: the API key is sent as `Authorization` to the configured `baseUrl` and never appears in a tool result. Tool arguments and results are written to the session log — don't paste keys into prompts
- **File access**: reads the file at `source` when it's a local path, and nothing else
- **Network access**: only `baseUrl` and the presigned storage target it returns
- **No eval, no subprocesses**
- Privilege boundary: an API key works for dubbing endpoints only — it **cannot** mint further API keys

## Or use MCP

If you'd rather not install a plugin, the same service is available as a hosted MCP server via the official bridge:

```yaml
- id: mcp-pinch
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: pinch
    transport: streamable-http
    url: https://portal.startpinch.com/api/mcp
    headers:
      Authorization: !!js `Bearer ${process.env.PINCH_API_KEY}`
```

The difference: MCP exposes the full API surface (uploads, subtitles, balance, job listing), which is more tools and finer grained. This plugin is three task-shaped tools with direct local-file upload and results trimmed for the model. Use the plugin for everyday dubbing, MCP when you need the whole API.

## Development

```bash
npm install
npm run check   # typecheck + test + build
```

## License

MIT
