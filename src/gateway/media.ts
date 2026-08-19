/**
 * CDN media download + AES-128-ECB decryption for inbound images.
 *
 * Ported from Tencent/openclaw-weixin src/cdn (MIT) — see LICENSE.
 *
 * @module dsh-wechat-bridge/gateway/media
 */

import { createDecipheriv } from 'node:crypto'
import type { ImageItem } from './types.ts'
import { assertCdnUrl, MEDIA_DOWNLOAD_MAX_BYTES, WEIXIN_CDN_BASE_URL } from './types.ts'

/** Decrypt AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Parse an AES key into a raw 16-byte Buffer. Two encodings are seen:
 *   - base64(raw 16 bytes)                      → images (media.aes_key)
 *   - base64(hex string of 16 bytes)            → file / voice / video
 *   - plain hex string of 16 bytes (32 chars)   → ImageItem.aeskey
 */
export function parseAesKey(input: string): Buffer {
  const trimmed = input.trim()
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`)
}

/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/** Guess a file extension from magic bytes (jpg/png/gif/webp/bmp, else bin). */
export function detectImageExt(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF87a') return 'gif'
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp'
  return 'bin'
}

export interface DownloadImageResult {
  data: Buffer
  ext: string
}

/** Per-hop fetch timeout for CDN downloads (F4). */
export const CDN_DOWNLOAD_TIMEOUT_MS = 30_000
/** Max manual 3xx redirects followed during a CDN download (F4). */
const MAX_CDN_REDIRECTS = 3

/**
 * Fetch a CDN URL with `redirect: 'manual'` and follow 3xx ourselves so every
 * hop re-passes assertCdnUrl. At most MAX_CDN_REDIRECTS hops; the final
 * response is returned (non-2xx is rejected by the caller).
 */
async function fetchCdnWithRedirects(
  startUrl: URL,
  extraTrustedHosts: readonly string[] | undefined,
  fetchFn: typeof fetch,
): Promise<Response> {
  let url = startUrl
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(CDN_DOWNLOAD_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_CDN_REDIRECTS) {
        throw new Error(`CDN download exceeded ${MAX_CDN_REDIRECTS} redirects`)
      }
      const location = res.headers.get('location')
      if (!location) throw new Error(`CDN redirect ${res.status} without Location header`)
      // Absolute-ize the target and re-validate before following.
      url = assertCdnUrl(new URL(location, url).toString(), extraTrustedHosts)
      continue
    }
    return res
  }
}

/**
 * Download and decrypt one inbound image. Prefers the server-provided
 * `full_url`, then the client-built URL from `encrypt_query_param`.
 *
 * F4: the URL must pass assertCdnUrl, redirects are followed manually (each
 * hop re-validated, max 3), the body is streamed with a hard size cap and a
 * per-hop 30s timeout. `fetchFn` is injectable for tests.
 */
export async function downloadImage(params: {
  item: ImageItem
  cdnBaseUrl?: string
  extraTrustedHosts?: readonly string[]
  fetchFn?: typeof fetch
}): Promise<DownloadImageResult> {
  const { item } = params
  const cdnBaseUrl = params.cdnBaseUrl || WEIXIN_CDN_BASE_URL
  const fetchFn = params.fetchFn ?? globalThis.fetch
  const media = item.media ?? {}
  const fullUrl = media.full_url?.trim()
  const itemUrl = item.url?.trim()
  const encParam = media.encrypt_query_param?.trim()
  // Empty encrypt_query_param with no full_url/item.url: fail BEFORE any
  // fetch (this used to be dead code — buildCdnDownloadUrl('') is truthy).
  if (!fullUrl && !itemUrl && !encParam) {
    throw new Error('image item has no url/encrypt_query_param')
  }
  const rawUrl = fullUrl || itemUrl || buildCdnDownloadUrl(encParam ?? '', cdnBaseUrl)
  const cdnUrl = assertCdnUrl(rawUrl, params.extraTrustedHosts)

  const res = await fetchCdnWithRedirects(cdnUrl, params.extraTrustedHosts, fetchFn)
  if (!res.ok) {
    throw new Error(`CDN download ${res.status} ${res.statusText}`)
  }
  // Size cap from the declared Content-Length when present…
  const contentLength = Number(res.headers.get('content-length') ?? '') || 0
  if (contentLength > MEDIA_DOWNLOAD_MAX_BYTES) {
    throw new Error(`CDN download too large: ${contentLength} bytes > ${MEDIA_DOWNLOAD_MAX_BYTES}`)
  }
  // …and enforced while streaming — never a blind arrayBuffer() read.
  const chunks: Buffer[] = []
  let total = 0
  if (res.body) {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > MEDIA_DOWNLOAD_MAX_BYTES) {
        throw new Error(`CDN download exceeded ${MEDIA_DOWNLOAD_MAX_BYTES} bytes`)
      }
      chunks.push(buf)
    }
  }
  const encrypted = Buffer.concat(chunks)
  const keyInput = item.aeskey || media.aes_key
  if (!keyInput) throw new Error('image item has no aes key')
  const key = parseAesKey(keyInput)
  const data = decryptAesEcb(encrypted, key)
  return { data, ext: detectImageExt(data) }
}
