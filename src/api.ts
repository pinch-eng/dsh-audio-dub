/**
 * Thin client over the Pinch dubbing REST API.
 *
 * Deliberately hand-rolled `fetch` with no SDK dependency: this plugin runs
 * inside someone else's agent process, and a transitive dependency tree is
 * both a supply-chain surface and a version-conflict risk for the host.
 */

export const DEFAULT_BASE_URL = 'https://portal.startpinch.com'

/** Target languages the dubbing API accepts. `auto` is source-side only. */
export const TARGET_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'] as const
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<TargetLanguage, { en: string; zh: string }> = {
  en: { en: 'English', zh: '英语' },
  es: { en: 'Spanish', zh: '西班牙语' },
  fr: { en: 'French', zh: '法语' },
  de: { en: 'German', zh: '德语' },
  it: { en: 'Italian', zh: '意大利语' },
  pt: { en: 'Portuguese', zh: '葡萄牙语' },
  ru: { en: 'Russian', zh: '俄语' },
  ja: { en: 'Japanese', zh: '日语' },
  ko: { en: 'Korean', zh: '韩语' },
  zh: { en: 'Chinese', zh: '中文' },
}

/** Statuses from which a job will never move again. */
export const TERMINAL_STATUSES = ['completed', 'failed'] as const

export interface JobStatus {
  job_id: string
  status: string
  source_lang: string
  target_lang: string
  progress?: number | null
  input_duration_sec?: number | null
  cost_usd?: number | null
  output_url?: string | null
  output_expires_at?: string | null
  subtitles_original_url?: string | null
  subtitles_translated_url?: string | null
  error?: { code: string; message: string } | null
}

export interface CreatedJob {
  job_id: string
  status: string
  source_lang: string
  target_lang: string
  created_at: string
}

export interface UploadTarget {
  upload_url: string
  source_url: string
}

/**
 * An API failure with the server's own error code preserved.
 *
 * The code matters to the model: `insufficient_balance` needs a top-up,
 * `video_too_long` needs a shorter file, `unauthorized` needs a key — three
 * very different next actions that a flattened "request failed" would hide.
 */
export class PinchApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'PinchApiError'
  }
}

export interface ClientOptions {
  apiKey: string
  baseUrl?: string
  signal?: AbortSignal
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function request<T>(
  { apiKey, baseUrl = DEFAULT_BASE_URL, signal }: ClientOptions,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let res: Response
  try {
    res = await fetch(endpoint(baseUrl, path), {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new PinchApiError('network_error', `Could not reach the Pinch API: ${(err as Error).message}`, 0)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new PinchApiError(
      body?.error?.code ?? `http_${res.status}`,
      body?.error?.message ?? `Request failed with HTTP ${res.status}`,
      res.status,
    )
  }
  return await res.json() as T
}

/** Submit a dub for a publicly reachable media URL. */
export function createJob(
  opts: ClientOptions,
  params: {
    source_url: string
    target_lang: string
    source_lang?: string
    reduce_accent?: boolean
    watermark?: boolean
  },
): Promise<CreatedJob> {
  return request<CreatedJob>(opts, '/api/dubbing/jobs', { method: 'POST', body: params })
}

export function getJob(opts: ClientOptions, jobId: string): Promise<JobStatus> {
  return request<JobStatus>(opts, `/api/dubbing/jobs/${encodeURIComponent(jobId)}`)
}

/** Fresh presigned download URL for a completed job (the stored one expires). */
export function getResult(opts: ClientOptions, jobId: string): Promise<{ download_url: string; expires_at: string }> {
  return request(opts, `/api/dubbing/jobs/${encodeURIComponent(jobId)}/result`)
}

export function createUploadTarget(
  opts: ClientOptions,
  params: { filename: string; content_type: string },
): Promise<UploadTarget> {
  return request<UploadTarget>(opts, '/api/dubbing/upload-url', { method: 'POST', body: params })
}
