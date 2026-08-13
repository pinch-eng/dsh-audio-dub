import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentTypeFor, formatBytes, isHttpUrl, uploadLocalFile } from '../src/upload.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://x.test/a.mp4')).toBe(true)
    expect(isHttpUrl('http://x.test/a.mp4')).toBe(true)
  })

  it('treats paths and other schemes as local sources', () => {
    expect(isHttpUrl('./talk.mp4')).toBe(false)
    expect(isHttpUrl('/Users/me/talk.mp4')).toBe(false)
    expect(isHttpUrl('C:\\videos\\talk.mp4')).toBe(false)
    // A file: URL is not fetchable by the dubbing worker, so it must upload.
    expect(isHttpUrl('file:///Users/me/talk.mp4')).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it('maps known media extensions case-insensitively', () => {
    expect(contentTypeFor('a.mp4')).toBe('video/mp4')
    expect(contentTypeFor('A.MOV')).toBe('video/quicktime')
    expect(contentTypeFor('podcast.mp3')).toBe('audio/mpeg')
  })

  it('falls back to octet-stream for anything else', () => {
    expect(contentTypeFor('notes.txt')).toBe('application/octet-stream')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
  })
})

describe('formatBytes', () => {
  it('switches to GB past 1024 MB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })
})

describe('uploadLocalFile', () => {
  it('rejects a missing file before touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadLocalFile({ apiKey: 'pk_test' }, '/nope/missing.mp4'))
      .rejects.toMatchObject({ code: 'invalid_source' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pinch-'))
    const path = join(dir, 'empty.mp4')
    await writeFile(path, '')
    await expect(uploadLocalFile({ apiKey: 'pk_test' }, path))
      .rejects.toMatchObject({ code: 'invalid_source' })
  })

  it('uploads with the signed content type and returns the source url', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pinch-'))
    const path = join(dir, 'clip.mp4')
    await writeFile(path, 'not really a video')

    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/api/dubbing/upload-url')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ upload_url: 'https://s3.test/put', source_url: 'https://s3.test/get' }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))

    const result = await uploadLocalFile({ apiKey: 'pk_test' }, path)
    expect(result.source_url).toBe('https://s3.test/get')
    expect(result.size_bytes).toBe('not really a video'.length)

    const put = calls[1]!
    expect(put.url).toBe('https://s3.test/put')
    expect(put.init.method).toBe('PUT')
    const headers = put.init.headers as Record<string, string>
    // Must match what the URL was signed for, or storage rejects with a 403.
    expect(headers['Content-Type']).toBe('video/mp4')
    expect(headers['Content-Length']).toBe(String(result.size_bytes))
  })

  it('surfaces a storage rejection as upload_failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pinch-'))
    const path = join(dir, 'clip.mp4')
    await writeFile(path, 'bytes')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/dubbing/upload-url')) {
        return { ok: true, status: 200, json: async () => ({ upload_url: 'https://s3.test/put', source_url: 'https://s3.test/get' }) }
      }
      return { ok: false, status: 403, json: async () => ({}) }
    }))

    await expect(uploadLocalFile({ apiKey: 'pk_test' }, path))
      .rejects.toMatchObject({ code: 'upload_failed', httpStatus: 403 })
  })
})
