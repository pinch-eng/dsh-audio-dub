import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJob, getJob, PinchApiError, TARGET_LANGUAGES, LANGUAGE_NAMES } from '../src/api.ts'

const opts = { apiKey: 'pk_test', baseUrl: 'https://example.test' }

function mockFetch(response: { ok: boolean; status?: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

describe('language table', () => {
  it('names every supported target language in both languages', () => {
    for (const code of TARGET_LANGUAGES) {
      expect(LANGUAGE_NAMES[code].en.length).toBeGreaterThan(0)
      expect(LANGUAGE_NAMES[code].zh.length).toBeGreaterThan(0)
    }
  })
})

describe('createJob', () => {
  it('sends the key as a bearer token and posts JSON', async () => {
    const fetchMock = mockFetch({ ok: true, body: { job_id: 'j1', status: 'pending' } })
    await createJob(opts, { source_url: 'https://x.test/a.mp4', target_lang: 'en' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/api/dubbing/jobs')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pk_test')
    expect(JSON.parse(init.body as string)).toEqual({ source_url: 'https://x.test/a.mp4', target_lang: 'en' })
  })

  it('preserves the server error code so the caller can act on it', async () => {
    mockFetch({
      ok: false,
      status: 402,
      body: { error: { code: 'insufficient_balance', message: 'Balance too low' } },
    })
    await expect(createJob(opts, { source_url: 'https://x.test/a.mp4', target_lang: 'en' }))
      .rejects.toMatchObject({ code: 'insufficient_balance', httpStatus: 402 })
  })

  it('reports an unreachable API as a network error rather than crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const err = await createJob(opts, { source_url: 'https://x.test/a.mp4', target_lang: 'en' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PinchApiError)
    expect((err as PinchApiError).code).toBe('network_error')
  })

  it('falls back to an http_ code when the body carries no error object', async () => {
    mockFetch({ ok: false, status: 502, body: null })
    await expect(getJob(opts, 'j1')).rejects.toMatchObject({ code: 'http_502' })
  })
})

describe('getJob', () => {
  it('url-encodes the job id', async () => {
    const fetchMock = mockFetch({ ok: true, body: { job_id: 'a/b', status: 'completed' } })
    await getJob(opts, 'a/b')
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://example.test/api/dubbing/jobs/a%2Fb')
  })

  it('trims a trailing slash off the base url', async () => {
    const fetchMock = mockFetch({ ok: true, body: { job_id: 'j1' } })
    await getJob({ ...opts, baseUrl: 'https://example.test/' }, 'j1')
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://example.test/api/dubbing/jobs/j1')
  })
})
