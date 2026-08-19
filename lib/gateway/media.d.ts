/**
 * CDN media download + AES-128-ECB decryption for inbound images.
 *
 * Ported from Tencent/openclaw-weixin src/cdn (MIT) — see LICENSE.
 *
 * @module dsh-wechat-bridge/gateway/media
 */
import type { ImageItem } from './types.ts';
/** Decrypt AES-128-ECB (PKCS7 padding). */
export declare function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer;
/**
 * Parse an AES key into a raw 16-byte Buffer. Two encodings are seen:
 *   - base64(raw 16 bytes)                      → images (media.aes_key)
 *   - base64(hex string of 16 bytes)            → file / voice / video
 *   - plain hex string of 16 bytes (32 chars)   → ImageItem.aeskey
 */
export declare function parseAesKey(input: string): Buffer;
/** Build a CDN download URL from encrypt_query_param. */
export declare function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string;
/** Guess a file extension from magic bytes (jpg/png/gif/webp/bmp, else bin). */
export declare function detectImageExt(data: Buffer): string;
export interface DownloadImageResult {
    data: Buffer;
    ext: string;
}
/** Per-hop fetch timeout for CDN downloads (F4). */
export declare const CDN_DOWNLOAD_TIMEOUT_MS = 30000;
/**
 * Download and decrypt one inbound image. Prefers the server-provided
 * `full_url`, then the client-built URL from `encrypt_query_param`.
 *
 * F4: the URL must pass assertCdnUrl, redirects are followed manually (each
 * hop re-validated, max 3), the body is streamed with a hard size cap and a
 * per-hop 30s timeout. `fetchFn` is injectable for tests.
 */
export declare function downloadImage(params: {
    item: ImageItem;
    cdnBaseUrl?: string;
    extraTrustedHosts?: readonly string[];
    fetchFn?: typeof fetch;
}): Promise<DownloadImageResult>;
//# sourceMappingURL=media.d.ts.map