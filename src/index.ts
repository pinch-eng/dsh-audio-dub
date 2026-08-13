/**
 * DSH Pinch dubbing plugin.
 *
 * Registers three tools:
 *   dub_media     — dub a local file or URL into another language (voice cloned)
 *   dub_status    — check / wait on a running job
 *   dub_languages — list the supported language codes
 *
 * Install: add to cordis.yml
 *   - id: audio-dub
 *     name: 'dsh-audio-dub'
 *
 * Credentials come from PINCH_API_KEY (or `config.apiKey`). The key is only
 * ever sent as an Authorization header to the configured base URL, and is
 * never included in a tool result — tool arguments and results land in the
 * session log.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createJob,
  getJob,
  getResult,
  LANGUAGE_NAMES,
  PinchApiError,
  TARGET_LANGUAGES,
  DEFAULT_BASE_URL,
} from './api.ts'
import type { ClientOptions, JobStatus } from './api.ts'
import { isHttpUrl, uploadLocalFile } from './upload.ts'

export const name = 'dsh-audio-dub'
export const inject = ['tools']

export interface Config {
  /** Pinch API key (`pk_…`). Defaults to process.env.PINCH_API_KEY. */
  apiKey?: string
  /** Override for self-hosted or staging deployments. */
  baseUrl?: string
  /** Delay between status polls while waiting. Default 15s, floor 5s. */
  pollIntervalMs?: number
}

const DEFAULT_POLL_MS = 15_000
const MIN_POLL_MS = 5_000
const DEFAULT_WAIT_SECONDS = 600
const MAX_WAIT_SECONDS = 1800
/** Tool ceiling: the longest wait a caller can ask for, plus room to finish up. */
const TOOL_TIMEOUT_MS = (MAX_WAIT_SECONDS + 60) * 1000

const PRICE_PER_MINUTE_USD = 0.5

/**
 * Structurally identical to the harness's own `JsonValue`. Declared locally so
 * this plugin doesn't take a peer dependency on the session package just for a
 * type — tool results must round-trip losslessly through the session log.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonRecord = { [key: string]: Json }

/** Drop undefined values — undefined is not JSON. */
function clean(obj: Record<string, Json | undefined>): JsonRecord {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as JsonRecord
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Turn any failure into a result the model can act on.
 *
 * A thrown error becomes an opaque "tool failed" line; a returned object keeps
 * the server's error code, which is what distinguishes "top up your balance"
 * from "this file is too long" from "your key is wrong".
 */
function errorResult(err: unknown): JsonRecord {
  if (err instanceof PinchApiError) {
    return clean({
      ok: false,
      error_code: err.code,
      error: err.message,
      hint: HINTS[err.code],
    })
  }
  return { ok: false, error_code: 'unexpected', error: (err as Error).message ?? String(err) }
}

const HINTS: Record<string, string> = {
  unauthorized: 'Set PINCH_API_KEY to a valid key from https://portal.startpinch.com/dashboard/api-keys',
  insufficient_balance: 'Top up at https://portal.startpinch.com/dashboard/billing',
  video_too_long: 'The limit is 60 minutes. Split the file and dub the parts separately.',
  video_too_large: 'The limit is 2 GB. Re-encode smaller or split the file.',
  unsupported_language: `Supported target languages: ${TARGET_LANGUAGES.join(', ')}`,
  invalid_url: 'source must be a direct link to a media file (not a YouTube/social page) or a local file path.',
  network_error: 'Check network access to the Pinch API from this machine.',
}

/** Everything the model should know about a job, in one shape. */
function jobSummary(job: JobStatus, extra?: JsonRecord): JsonRecord {
  return clean({
    ok: true,
    job_id: job.job_id,
    status: job.status,
    done: isTerminal(job.status),
    source_lang: job.source_lang,
    target_lang: job.target_lang,
    progress: job.progress ?? undefined,
    duration_sec: job.input_duration_sec ?? undefined,
    cost_usd: job.cost_usd ?? undefined,
    download_url: job.output_url ?? undefined,
    download_expires_at: job.output_expires_at ?? undefined,
    subtitles_original_url: job.subtitles_original_url ?? undefined,
    subtitles_translated_url: job.subtitles_translated_url ?? undefined,
    error: job.error ? `[${job.error.code}] ${job.error.message}` : undefined,
    ...extra,
  })
}

/** Human-facing one-liner for the transcript. */
function renderSummary(value: JsonRecord): string {
  if (value.ok === false) {
    return `Dubbing failed — ${value.error_code}: ${value.error}${value.hint ? `\n${value.hint}` : ''}`
  }
  const lines: string[] = []
  const status = String(value.status ?? 'unknown')
  lines.push(`Job ${value.job_id} — ${status}${value.progress != null ? ` (${value.progress}%)` : ''}`)
  if (value.source_lang && value.target_lang) lines.push(`${value.source_lang} → ${value.target_lang}`)
  if (value.duration_sec != null) lines.push(`duration ${Math.round(Number(value.duration_sec))}s`)
  if (value.cost_usd != null) lines.push(`cost $${Number(value.cost_usd).toFixed(2)}`)
  if (value.error) lines.push(String(value.error))
  if (value.download_url) lines.push(`Download: ${value.download_url}`)
  if (!value.done && value.job_id) lines.push(`Not finished — call dub_status with job_id "${value.job_id}".`)
  return lines.join('\n')
}

/**
 * Poll until the job settles, the budget runs out, or the run is aborted.
 * Returns the last status seen either way — a timeout is not a failure, the
 * job keeps running server-side and `dub_status` can pick it up later.
 */
async function waitForJob(
  opts: ClientOptions,
  jobId: string,
  budgetMs: number,
  pollMs: number,
): Promise<JobStatus> {
  const deadline = Date.now() + budgetMs
  let job = await getJob(opts, jobId)
  while (!isTerminal(job.status) && Date.now() < deadline) {
    if (opts.signal?.aborted) return job
    const remaining = deadline - Date.now()
    await sleep(Math.min(pollMs, Math.max(0, remaining)), opts.signal)
    job = await getJob(opts, jobId)
  }
  return job
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const pollMs = Math.max(MIN_POLL_MS, config.pollIntervalMs ?? DEFAULT_POLL_MS)

  /** Resolved per call: a key set after startup should just start working. */
  function credentials(signal?: AbortSignal): ClientOptions {
    const apiKey = config.apiKey ?? process.env.PINCH_API_KEY ?? ''
    if (!apiKey) {
      throw new PinchApiError(
        'unauthorized',
        'No API key configured. Set PINCH_API_KEY in the environment.',
        401,
      )
    }
    return { apiKey, baseUrl, ...(signal ? { signal } : {}) }
  }

  // ------------------------------------------------------------- dub_media
  ctx.tools.register(defineTool({
    name: 'dub_media',
    description:
      'Dub a video or audio file into another language, keeping the original speaker\'s voice (AI voice cloning). ' +
      'Accepts a local file path or a direct media URL. Typical use: turn a Chinese video into English, or vice versa. ' +
      `Supported target languages: ${TARGET_LANGUAGES.join(', ')}. Costs $${PRICE_PER_MINUTE_USD.toFixed(2)} per minute of media. ` +
      'Processing is asynchronous: by default this waits for the result and returns a download URL; ' +
      'if the wait budget runs out it returns a job_id to pass to dub_status.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description:
          'Local file path (e.g. ./talk.mp4) or a direct HTTP(S) link to a media file. ' +
          'Page URLs (YouTube, Bilibili, social posts) are not media files and will be rejected.',
      },
      target_lang: {
        type: 'string',
        required: true,
        enum: TARGET_LANGUAGES,
        description: 'Language to dub into.',
      },
      source_lang: {
        type: 'string',
        enum: ['auto', ...TARGET_LANGUAGES],
        description: 'Language spoken in the source. Default "auto" (detected).',
      },
      reduce_accent: {
        type: 'boolean',
        description:
          'Make the dubbed speech sound more native in the target language, at a slight cost to voice similarity. ' +
          'Leave unset to use the service default.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for the dub to finish before returning. Default true.',
      },
      wait_seconds: {
        type: 'integer',
        description: `How long to wait, in seconds. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}. Roughly, allow 1-2x the media duration.`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value as JsonRecord) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => {
      try {
        const opts = credentials(exec.signal)
        let sourceUrl = args.source
        let uploadedBytes: number | undefined

        if (!isHttpUrl(args.source)) {
          const result = await uploadLocalFile(opts, args.source)
          sourceUrl = result.source_url
          uploadedBytes = result.size_bytes
        }

        const created = await createJob(opts, clean({
          source_url: sourceUrl,
          target_lang: args.target_lang,
          source_lang: args.source_lang ?? 'auto',
          reduce_accent: args.reduce_accent,
        }) as Parameters<typeof createJob>[1])

        if (args.wait === false) {
          return jobSummary(
            { ...created, progress: null, output_url: null } as JobStatus,
            clean({
              uploaded_bytes: uploadedBytes,
              note: 'Submitted. Call dub_status with this job_id to follow it.',
            }),
          )
        }

        const budgetSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, args.wait_seconds ?? DEFAULT_WAIT_SECONDS))
        const job = await waitForJob(opts, created.job_id, budgetSeconds * 1000, pollMs)

        // A completed job's stored URL may already be stale; ask for a fresh one.
        if (job.status === 'completed' && !job.output_url) {
          const fresh = await getResult(opts, job.job_id).catch(() => null)
          if (fresh) job.output_url = fresh.download_url
        }
        return jobSummary(job, clean({
          uploaded_bytes: uploadedBytes,
          note: isTerminal(job.status)
            ? undefined
            : `Still running after ${budgetSeconds}s. Call dub_status with this job_id.`,
        }))
      } catch (err) {
        return errorResult(err)
      }
    },
  }))

  // ------------------------------------------------------------ dub_status
  ctx.tools.register(defineTool({
    name: 'dub_status',
    description:
      'Check a dubbing job started by dub_media, optionally waiting for it to finish. ' +
      'Returns status, progress, cost, and the download URL once complete.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by dub_media.' },
      wait: { type: 'boolean', description: 'Wait for completion instead of returning the current status. Default false.' },
      wait_seconds: {
        type: 'integer',
        description: `How long to wait when wait is true. Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value as JsonRecord) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => {
      try {
        const opts = credentials(exec.signal)
        const budgetSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, args.wait_seconds ?? DEFAULT_WAIT_SECONDS))
        const job = args.wait === true
          ? await waitForJob(opts, args.job_id, budgetSeconds * 1000, pollMs)
          : await getJob(opts, args.job_id)

        if (job.status === 'completed' && !job.output_url) {
          const fresh = await getResult(opts, job.job_id).catch(() => null)
          if (fresh) job.output_url = fresh.download_url
        }
        return jobSummary(job)
      } catch (err) {
        return errorResult(err)
      }
    },
  }))

  // --------------------------------------------------------- dub_languages
  ctx.tools.register(defineTool({
    name: 'dub_languages',
    description:
      'List the language codes dub_media accepts, with English and Chinese names. ' +
      'Local lookup — no network call, no cost.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const langs = (value as { languages: { code: string; en: string; zh: string }[] }).languages
        return [{
          type: 'text',
          text: `Target languages (source can also be "auto"):\n${
            langs.map((l) => `  ${l.code} — ${l.en} / ${l.zh}`).join('\n')
          }\nPrice: $${PRICE_PER_MINUTE_USD.toFixed(2)} per minute of media.`,
        }]
      },
    },
    timeoutMs: 1000,
    execute: () => Promise.resolve({
      languages: TARGET_LANGUAGES.map((code) => ({ code, ...LANGUAGE_NAMES[code] })),
      source_lang_extra: 'auto',
      price_per_minute_usd: PRICE_PER_MINUTE_USD,
    }),
  }))
}
