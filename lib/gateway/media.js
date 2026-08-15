/**
 * CDN media download + AES-128-ECB decryption for inbound images.
 *
 * Ported from Tencent/openclaw-weixin src/cdn (MIT) — see LICENSE.
 *
 * @module dsh-wechat-bridge/gateway/media
 */
import { createDecipheriv } from 'node:crypto';
import { WEIXIN_CDN_BASE_URL } from "./types.js";
/** Decrypt AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/**
 * Parse an AES key into a raw 16-byte Buffer. Two encodings are seen:
 *   - base64(raw 16 bytes)                      → images (media.aes_key)
 *   - base64(hex string of 16 bytes)            → file / voice / video
 *   - plain hex string of 16 bytes (32 chars)   → ImageItem.aeskey
 */
export function parseAesKey(input) {
    const trimmed = input.trim();
    if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 16)
        return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
        return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
}
/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
/** Guess a file extension from magic bytes (jpg/png/gif/webp/bmp, else bin). */
export function detectImageExt(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'jpg';
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'png';
    if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF87a')
        return 'gif';
    if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF89a')
        return 'gif';
    if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP')
        return 'webp';
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d)
        return 'bmp';
    return 'bin';
}
/**
 * Download and decrypt one inbound image. Prefers the server-provided
 * `full_url`, then the client-built URL from `encrypt_query_param`.
 */
export async function downloadImage(params) {
    const { item } = params;
    const cdnBaseUrl = params.cdnBaseUrl || WEIXIN_CDN_BASE_URL;
    const media = item.media ?? {};
    const url = media.full_url || item.url || buildCdnDownloadUrl(media.encrypt_query_param ?? '', cdnBaseUrl);
    if (!url)
        throw new Error('image item has no url/encrypt_query_param');
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`CDN download ${res.status} ${res.statusText}`);
    }
    const encrypted = Buffer.from(await res.arrayBuffer());
    const keyInput = item.aeskey || media.aes_key;
    if (!keyInput)
        throw new Error('image item has no aes key');
    const key = parseAesKey(keyInput);
    const data = decryptAesEcb(encrypted, key);
    return { data, ext: detectImageExt(data) };
}
//# sourceMappingURL=media.js.map