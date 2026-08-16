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
import { type MessageItem } from './types.ts';
/** Encrypt buffer with AES-128-ECB (PKCS7 padding is the default). */
export declare function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer;
/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export declare function aesEcbPaddedSize(plaintextSize: number): number;
/** Build a CDN upload URL from upload_param and filekey. */
export declare function buildCdnUploadUrl(params: {
    cdnBaseUrl: string;
    uploadParam: string;
    filekey: string;
}): string;
export declare const UPLOAD_MAX_RETRIES = 3;
/** Hard cap for a single media upload — our own exports, kept sane. */
export declare const UPLOAD_MAX_BYTES: number;
/**
 * Encode a raw AES key for `CDNMedia.aes_key`.
 *
 * Matches the official client's own outbound media exactly (captured from
 * real inbound items): base64 of the key's HEX STRING (44 chars for a 16-byte
 * key) — the inbound `media.aes_key` decodes to the hex string.
 */
export declare function encodeMediaAesKey(aeskey: Buffer): string;
/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Retries up to UPLOAD_MAX_RETRIES on server errors; 4xx aborts immediately
 * (official cdn-upload.ts semantics).
 */
export declare function uploadBufferToCdn(params: {
    buf: Buffer;
    uploadFullUrl?: string;
    uploadParam?: string;
    filekey: string;
    cdnBaseUrl: string;
    aeskey: Buffer;
}): Promise<{
    downloadParam: string;
}>;
/** Hash helpers shared by the upload entry points. */
export declare function md5Hex(buf: Buffer): string;
export declare function randomHex(bytes: number): string;
/**
 * Assemble the outbound media `MessageItem` — the EXACT shape the production
 * pipeline sends (kept here as one pure function so tests and the standalone
 * probe (scripts/probe-media.mjs) exercise the same assembly code the gateway
 * runs). Field-for-field mirror of the official client's outbound shape
 * (captured from real inbound media messages):
 *
 * - `encrypt_query_param` = the LONG getUploadUrl `upload_param` structure
 *   (NOT the CDN `x-encrypted-param` header — that one delivers a bubble but
 *   its content fetch is rejected with 400 on download);
 * - `aes_key` = base64 of the key's HEX STRING (44 chars);
 * - `full_url` = complete download URL with the same param (absolute — a
 *   relative URL here is a defect, see porting-notes §6);
 * - NO `encrypt_type` (the official outbound shape carries none);
 * - image additionally carries `image_item.aeskey` (hex) + `mid_size`
 *   (ciphertext size); file carries `file_name` + `len` (raw size).
 *
 * Any single-field deviation trips prepare validation or silent drops
 * (see docs/porting-notes.md §6 matrix).
 */
export declare function buildOutboundMediaItem(params: {
    mediaType: number;
    /** The `upload_param` returned by getUploadUrl (required, non-empty). */
    uploadParam: string;
    aeskey: Buffer;
    /** Absolute CDN base URL (e.g. WEIXIN_CDN_BASE_URL) — never empty. */
    cdnBaseUrl: string;
    rawsize: number;
    fileName: string;
}): MessageItem;
//# sourceMappingURL=upload.d.ts.map