# dsh-audio-dub

[English](README.md)

DSH 视频/音频配音插件 —— 把一段视频或音频配音成另一种语言，并保留原说话人的音色（AI 声音克隆）。中文视频一句话变成英文版本，反之亦然。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-lightgrey)](https://github.com/topics/dsh-plugin)

```
你：把 ./demo.mp4 配音成英文
Agent：[dub_media] Job 8f3a… — completed
       zh → en · duration 154s · cost $1.28
       Download: https://…/dubbed.mp4
```

## 动机

Agent 已经能处理文本翻译，但"把这个视频做成英文版"一直落在工具链之外：要么手动上传到某个网页，要么自己拼 ffmpeg + ASR + 翻译 + TTS + 对齐。

本插件把整条链路收成一个工具调用：**输入本地文件路径或媒体直链，输出配好音的成片下载地址**。转写、翻译、声音克隆、时间轴对齐都在服务端完成，Agent 只需要等结果。

## 安装

装到你的 profile（以 `headless` 为例，`web` / `tui` 同理）：

```bash
dsh plugin --profile headless add github:pinch-eng/dsh-audio-dub
```

安装后插件会自动注册，无需手动编辑 `cordis.yml`。然后设置 API key（在 [portal.startpinch.com](https://portal.startpinch.com/dashboard/api-keys) 创建，形如 `pk_…`）：

```bash
export PINCH_API_KEY=pk_xxx
```

试一下：

```bash
dsh --profile headless "把 ./demo.mp4 配音成英文"
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | `process.env.PINCH_API_KEY` | API key。**建议走环境变量**，不要写进 `cordis.yml` |
| `baseUrl` | string | `https://portal.startpinch.com` | 自建/测试环境时覆盖 |
| `pollIntervalMs` | integer | `15000` | 等待期间的轮询间隔，最小 5000 |

## 工具声明

### `dub_media` —— 配音

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | ✅ | 本地文件路径（`./talk.mp4`）或媒体文件直链。**不支持** YouTube / B 站等网页链接，那是页面不是媒体文件 |
| `target_lang` | string | ✅ | 目标语言，见下表 |
| `source_lang` | string | | 源语言，默认 `auto`（自动识别） |
| `reduce_accent` | boolean | | 让配音更接近目标语言母语发音，代价是音色相似度略降。不填则使用服务端默认值 |
| `wait` | boolean | | 是否等待完成，默认 `true` |
| `wait_seconds` | integer | | 等待预算，默认 600，最大 1800。经验值：留 1–2 倍素材时长 |

本地文件会先流式上传到预签名地址再提交任务——2GB 的 mp4 不会被读进内存。

超出等待预算不算失败：任务在服务端继续跑，返回的 `job_id` 交给 `dub_status` 即可。

### `dub_status` —— 查询任务

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_id` | string | ✅ | `dub_media` 返回的任务 id |
| `wait` | boolean | | 是否等待完成，默认 `false`（只查当前状态） |
| `wait_seconds` | integer | | 同上 |

### `dub_languages` —— 支持的语言

无参数，本地查表，不联网、不计费。

## 支持的语言

| 代码 | 语言 | 代码 | 语言 |
|---|---|---|---|
| `zh` | 中文 | `pt` | 葡萄牙语 |
| `en` | 英语 | `ru` | 俄语 |
| `es` | 西班牙语 | `ja` | 日语 |
| `fr` | 法语 | `ko` | 韩语 |
| `de` | 德语 | `it` | 意大利语 |

源语言可额外填 `auto` 自动识别。

## 价格与限制

- **$0.50 / 分钟**（按素材时长计费）
- 单个文件最长 **60 分钟**、最大 **2 GB**
- 成片下载链接有效期 48 小时；过期后用 `dub_status` 重新获取

余额不足时工具返回 `insufficient_balance`，并附带充值地址，Agent 可以直接把这句话转达给你。

## 安全模型

- API key 通过 `Authorization` 请求头发往 `baseUrl`，不会出现在任何工具返回值里；但工具参数会进入会话日志，请不要把 key 写进 prompt。该 key 只能访问配音相关接口，**不能**用来创建新的 API key。
- `source` 为本地路径时读取该文件并上传，除此之外不读写任何文件；网络只访问 `baseUrl` 及其返回的预签名存储地址。

## 也可以走 MCP

如果你不想装插件，Pinch 同时提供托管的 MCP server，用官方 `mcp-client` 桥接即可：

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

两者的区别：MCP 暴露的是完整 API（含上传、字幕、余额查询等），工具更多更细；本插件是任务导向的三个工具，本地文件直传，返回值针对模型做了裁剪。日常配音建议用插件，需要完整 API 面时用 MCP。

## 开发

```bash
npm install
npm run check   # typecheck + test + build
```

## 文档

完整的参数说明、语言支持和 API 细节见 [startpinch.com/docs](https://startpinch.com/docs)。

## 许可证

MIT
