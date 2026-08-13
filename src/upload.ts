/**
 * Local-file support: the agent usually has the video on disk, not on a public
 * URL. We ask the API for a presigned target, stream the bytes straight to
 * storage, and hand the resulting URL back to the job.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import { createUploadTarget, PinchApiError } from './api.ts'
import type { ClientOptions } from './api.ts'

/** Hard cap enforced server-side too; failing here saves a pointless upload. */
export const MAX_FILE_SIZE_BYTES = 2_000_000_000

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** A source that is already a URL needs no upload; anything else is a path. */
export function isHttpUrl(source: string): boolean {
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/**
 * Upload a local file and return the URL to dub.
 *
 * Streamed rather than buffered: these are video files, and reading a 2 GB mp4
 * into the agent's heap to hand it to `fetch` would take the host process with
 * it.
 */
export async function uploadLocalFile(
  opts: ClientOptions,
  path: string,
): Promise<{ source_url: string; size_bytes: number }> {
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new PinchApiError('invalid_source', `Not a file: ${path}`, 0)
    size = info.size
  } catch (err) {
    if (err instanceof PinchApiError) throw err
    throw new PinchApiError('invalid_source', `Cannot read file: ${path}`, 0)
  }

  if (size === 0) throw new PinchApiError('invalid_source', `File is empty: ${path}`, 0)
  if (size > MAX_FILE_SIZE_BYTES) {
    throw new PinchApiError(
      'video_too_large',
      `File is ${formatBytes(size)}; the limit is ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
      0,
    )
  }

  const contentType = contentTypeFor(path)
  const { upload_url, source_url } = await createUploadTarget(opts, {
    filename: basename(path),
    content_type: contentType,
  })

  // `duplex: 'half'` is required by undici for a streamed body, and isn't in
  // the lib.dom RequestInit type — hence the assertion rather than a plain literal.
  const init = {
    method: 'PUT',
    // The presigned URL is signed for this exact content type — a mismatch is
    // rejected by storage with an opaque 403.
    headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(path)),
    duplex: 'half',
    signal: opts.signal,
  } as unknown as RequestInit

  const res = await fetch(upload_url, init)

  if (!res.ok) {
    throw new PinchApiError('upload_failed', `Upload failed with HTTP ${res.status}`, res.status)
  }
  return { source_url, size_bytes: size }
}
