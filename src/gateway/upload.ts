/**
 * CDN upload pipeline — field-for-field port of Tencent/openclaw-weixin
 * `src/cdn/aes-ecb.ts`, `src/cdn/cdn-url.ts` and `src/cdn/cdn-upload.ts`
 * (MIT, Copyright (C) 2026 Tencent). See LICENSE and docs/porting-notes.md §6.
 *
 * Flow: getUploadUrl → AES-128-ECB encrypt (PKCS7) → POST ciphertext to the
 * CDN → the response's `x-encrypted-param` header becomes the download
 * reference carried in the sent message item.
 *
 * @module dsh-wechat-bridge/gateway/upload
 */

import crypto from 'node:crypto'
import {
  ITEM_FILE,
  ITEM_IMAGE,
  ITEM_VIDEO,
  UPLOAD_MEDIA_IMAGE,
  UPLOAD_MEDIA_VIDEO,
  type MessageItem,
} from './types.ts'
import { assertCdnUrl } from './types.ts'

/** Encrypt buffer with AES-128-ECB (PKCS7 padding is the default). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/** Build a CDN upload URL from upload_param and filekey. */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string
  uploadParam: string
  filekey: string
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`
}

export const UPLOAD_MAX_RETRIES = 3

/** Hard cap for a single media upload — our own exports, kept sane. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/**
 * Encode a raw AES key for `CDNMedia.aes_key`.
 *
 * Matches the official client's own outbound media exactly (captured from
 * real inbound items): base64 of the key's HEX STRING (44 chars for a 16-byte
 * key) — the inbound `media.aes_key` decodes to the hex string.
 */
export function encodeMediaAesKey(aeskey: Buffer): string {
  return Buffer.from(aeskey.toString('hex'), 'utf-8').toString('base64')
}

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Retries up to UPLOAD_MAX_RETRIES on server errors; 4xx aborts immediately
 * (official cdn-upload.ts semantics).
 *
 * F4: the final POST URL (upload_full_url or the cdnBaseUrl-built URL) must
 * pass assertCdnUrl — the upload CDN shares the *.cdn.weixin.qq.com family.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  cdnBaseUrl: string
  aeskey: Buffer
  extraTrustedHosts?: readonly string[]
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey } = params
  const ciphertext = encryptAesEcb(buf, aeskey)
  const trimmedFull = uploadFullUrl?.trim()
  let cdnUrl: string
  if (trimmedFull) {
    cdnUrl = trimmedFull
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey })
  } else {
    throw new Error('CDN upload URL missing (need upload_full_url or upload_param)')
  }
  const trustedCdnUrl = assertCdnUrl(cdnUrl, params.extraTrustedHosts).toString()

  let downloadParam: string | undefined
  let lastError: unknown

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(trustedCdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN upload server error: ${errMsg}`)
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header')
      }
      break
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('client error')) throw err
      if (attempt >= UPLOAD_MAX_RETRIES) break
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`)
  }
  return { downloadParam }
}

/** Hash helpers shared by the upload entry points. */
export function md5Hex(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex')
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * Assemble the outbound media `MessageItem` — the EXACT shape the production
 * pipeline sends (kept here as one pure function so tests and the standalone
 * probe (scripts/probe-media.mjs) exercise the same assembly code the gateway
 * runs). Field-for-field mirror of the OFFICIAL outbound shape — verified
 * end-to-end on 2026-08-17 (real device received and rendered the image):
 *
 * - `encrypt_query_param` = the CDN upload response header `x-encrypted-param`
 *   (NOT the getUploadUrl `upload_param` — that structure is not recognized
 *   by the client renderer; see docs/porting-notes.md §6.1 FINAL);
 * - `aes_key` = base64 of the key's HEX STRING (44 chars);
 * - `encrypt_type` = 1 (required by the server's item validation);
 * - NO `full_url`, NO `image_item.aeskey` — both were local inventions that
 *   caused silent drops (client renderer); official shape carries neither;
 * - image carries `mid_size` (ciphertext size); file carries `file_name` +
 *   `len` (raw size).
 */
export function buildOutboundMediaItem(params: {
  mediaType: number
  /** The CDN upload response header `x-encrypted-param` (required, non-empty). */
  xep: string
  aeskey: Buffer
  rawsize: number
  fileName: string
}): MessageItem {
  const media = {
    encrypt_query_param: params.xep,
    aes_key: encodeMediaAesKey(params.aeskey),
    encrypt_type: 1,
  }
  if (params.mediaType === UPLOAD_MEDIA_IMAGE) {
    return { type: ITEM_IMAGE, image_item: { media, mid_size: aesEcbPaddedSize(params.rawsize) } }
  }
  if (params.mediaType === UPLOAD_MEDIA_VIDEO) {
    // Verified end-to-end 2026-08-17: type MUST be ITEM_VIDEO=5 (3 is VOICE —
    // the voice channel is server-accepted but client-silently-dropped).
    // Official openclaw shape: media + video_size only, no thumb required.
    return { type: ITEM_VIDEO, video_item: { media, video_size: aesEcbPaddedSize(params.rawsize) } }
  }
  return { type: ITEM_FILE, file_item: { media, file_name: params.fileName, len: String(params.rawsize) } }
}
