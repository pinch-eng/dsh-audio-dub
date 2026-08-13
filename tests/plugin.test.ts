import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'

/** Minimal stand-in for the harness: capture whatever the plugin registers. */
function fakeContext(): { ctx: Context; tools: Map<string, any> } {
  const tools = new Map<string, any>()
  const ctx = {
    tools: { register: (tool: any) => { tools.set(tool.name, tool) } },
  } as unknown as Context
  return { ctx, tools }
}

const exec = { signal: new AbortController().signal } as any

beforeEach(() => { delete process.env.PINCH_API_KEY })
afterEach(() => { vi.unstubAllGlobals() })

describe('plugin registration', () => {
  it('declares the tools service dependency', () => {
    expect(inject).toContain('tools')
    expect(name).toBe('dsh-audio-dub')
  })

  it('registers the three dubbing tools', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx)
    expect([...tools.keys()].sort()).toEqual(['dub_languages', 'dub_media', 'dub_status'])
  })
})

describe('dub_languages', () => {
  it('returns every language with both names and renders a readable list', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx)
    const tool = tools.get('dub_languages')

    const value = await tool.execute({}, exec)
    expect(value.languages).toHaveLength(10)
    expect(value.languages[0]).toEqual({ code: 'en', en: 'English', zh: '英语' })

    const [block] = tool.output.render({}, value)
    expect(block.type).toBe('text')
    expect(block.text).toContain('zh — Chinese / 中文')
  })
})

describe('dub_media', () => {
  it('returns an actionable error instead of throwing when no key is configured', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx)

    const value = await tools.get('dub_media').execute(
      { source: 'https://x.test/a.mp4', target_lang: 'en' },
      exec,
    )
    expect(value.ok).toBe(false)
    expect(value.error_code).toBe('unauthorized')
    // The hint is what lets the model tell the user how to fix it.
    expect(value.hint).toContain('PINCH_API_KEY')
  })

  it('submits a URL source without waiting and reports the job id', async () => {
    process.env.PINCH_API_KEY = 'pk_test'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ job_id: 'job-1', status: 'pending', source_lang: 'zh', target_lang: 'en' }),
    })))

    const { ctx, tools } = fakeContext()
    apply(ctx)
    const tool = tools.get('dub_media')
    const value = await tool.execute(
      { source: 'https://x.test/a.mp4', target_lang: 'en', source_lang: 'zh', wait: false },
      exec,
    )

    expect(value).toMatchObject({ ok: true, job_id: 'job-1', status: 'pending', done: false })
    expect(tool.output.render({}, value)[0].text).toContain('dub_status')
  })

  it('surfaces a low balance with the top-up hint', async () => {
    process.env.PINCH_API_KEY = 'pk_test'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: { code: 'insufficient_balance', message: 'Balance too low' } }),
    })))

    const { ctx, tools } = fakeContext()
    apply(ctx)
    const value = await tools.get('dub_media').execute(
      { source: 'https://x.test/a.mp4', target_lang: 'en' },
      exec,
    )
    expect(value).toMatchObject({ ok: false, error_code: 'insufficient_balance' })
    expect(value.hint).toContain('billing')
  })

  it('rejects an unsupported target language before calling the API', async () => {
    process.env.PINCH_API_KEY = 'pk_test'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { ctx, tools } = fakeContext()
    apply(ctx)
    // defineTool validates args against the declared enum.
    await expect(tools.get('dub_media').execute(
      { source: 'https://x.test/a.mp4', target_lang: 'kl' },
      exec,
    )).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('dub_status', () => {
  it('fetches a fresh download url when a completed job has none stored', async () => {
    process.env.PINCH_API_KEY = 'pk_test'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/result')) {
        return { ok: true, status: 200, json: async () => ({ download_url: 'https://s3.test/fresh', expires_at: 'later' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          job_id: 'job-1', status: 'completed', source_lang: 'zh', target_lang: 'en',
          output_url: null, cost_usd: 1.25, input_duration_sec: 150,
        }),
      }
    }))

    const { ctx, tools } = fakeContext()
    apply(ctx)
    const tool = tools.get('dub_status')
    const value = await tool.execute({ job_id: 'job-1' }, exec)

    expect(value).toMatchObject({ ok: true, done: true, download_url: 'https://s3.test/fresh' })
    const text = tool.output.render({}, value)[0].text
    expect(text).toContain('cost $1.25')
    expect(text).toContain('https://s3.test/fresh')
  })
})
