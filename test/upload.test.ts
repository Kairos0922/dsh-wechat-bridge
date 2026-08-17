/**
 * CDN upload + retention unit tests — pure functions, no network.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { aesEcbPaddedSize, buildCdnUploadUrl, buildOutboundMediaItem, encodeMediaAesKey, encryptAesEcb, md5Hex, randomHex } from '../src/gateway/upload.ts'
import { selectExpiredFiles } from '../src/node/retention.ts'
import { decryptAesEcb } from '../src/gateway/media.ts'
import { ITEM_FILE, ITEM_IMAGE, ITEM_VIDEO, UPLOAD_MEDIA_FILE, UPLOAD_MEDIA_IMAGE, UPLOAD_MEDIA_VIDEO } from '../src/gateway/types.ts'

test('encodeMediaAesKey is base64 of the HEX STRING (official-client shape)', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const encoded = encodeMediaAesKey(key)
  assert.equal(encoded, Buffer.from(key.toString('hex'), 'utf-8').toString('base64'))
  assert.equal(encoded.length, 44) // 32 hex chars → 44 base64 chars
})

test('aesEcbPaddedSize matches PKCS7 boundary (official formula)', () => {
  assert.equal(aesEcbPaddedSize(0), 16)
  assert.equal(aesEcbPaddedSize(1), 16)
  assert.equal(aesEcbPaddedSize(15), 16)
  assert.equal(aesEcbPaddedSize(16), 32)
  assert.equal(aesEcbPaddedSize(31), 32)
})

test('encryptAesEcb round-trips through the inbound decryptor', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const plaintext = Buffer.from('你好，微信文件通道测试 payload')
  const ciphertext = encryptAesEcb(plaintext, key)
  assert.equal(ciphertext.length, aesEcbPaddedSize(plaintext.length))
  assert.deepEqual(decryptAesEcb(ciphertext, key), plaintext)
})

test('buildCdnUploadUrl encodes upload_param and filekey', () => {
  const url = buildCdnUploadUrl({
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    uploadParam: 'a b?',
    filekey: 'k&y',
  })
  assert.equal(url, 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=a%20b%3F&filekey=k%26y')
})

test('md5Hex and randomHex basics', () => {
  assert.equal(md5Hex(Buffer.from('abc')).length, 32)
  assert.equal(randomHex(16).length, 32)
  assert.notEqual(randomHex(16), randomHex(16))
})

test('selectExpiredFiles keeps fresh files and drops expired ones', () => {
  const now = 1_000_000
  const files = [
    { path: '/m/old.png', mtimeMs: now - 100 },
    { path: '/m/fresh.png', mtimeMs: now - 10 },
    { path: '/m/ancient.png', mtimeMs: now - 10_000 },
  ]
  assert.deepEqual(selectExpiredFiles(files, now, 50), ['/m/old.png', '/m/ancient.png'])
})

test('buildOutboundMediaItem (IMAGE) mirrors the official outbound shape', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const item = buildOutboundMediaItem({
    mediaType: UPLOAD_MEDIA_IMAGE,
    xep: 'x-encrypted-param-header',
    aeskey: key,
    rawsize: 100,
    fileName: 'card.png',
  })
  assert.equal(item.type, ITEM_IMAGE)
  const media = item.image_item?.media
  assert.ok(media, 'image must carry media')
  // encrypt_query_param = CDN upload response header (verified end-to-end 2026-08-17)
  assert.equal(media.encrypt_query_param, 'x-encrypted-param-header')
  // aes_key = base64 of the HEX STRING (44 chars), NOT raw bytes (24 chars)
  assert.equal(media.aes_key, encodeMediaAesKey(key))
  assert.equal(media.aes_key.length, 44)
  // encrypt_type = 1 (server item validation requires it)
  assert.equal(media.encrypt_type, 1)
  // NO full_url, NO image_item.aeskey — local inventions that caused silent drops
  assert.equal(media.full_url, undefined)
  assert.equal(item.image_item?.aeskey, undefined)
  assert.equal(item.image_item?.mid_size, aesEcbPaddedSize(100))
})

test('buildOutboundMediaItem (VIDEO) uses ITEM_VIDEO=5 (verified end-to-end 2026-08-17)', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const item = buildOutboundMediaItem({
    mediaType: UPLOAD_MEDIA_VIDEO,
    xep: 'x-encrypted-param-header',
    aeskey: key,
    rawsize: 1024,
    fileName: 'clip.mp4',
  })
  assert.equal(item.type, ITEM_VIDEO)
  assert.equal(item.type, 5, '3 is VOICE — sending video as type 3 caused silent drops')
  assert.equal(item.video_item?.media?.encrypt_query_param, 'x-encrypted-param-header')
  assert.equal(item.video_item?.media?.encrypt_type, 1)
  assert.equal(item.video_item?.video_size, aesEcbPaddedSize(1024))
})

test('buildOutboundMediaItem (FILE) mirrors the official outbound shape', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const item = buildOutboundMediaItem({
    mediaType: UPLOAD_MEDIA_FILE,
    xep: 'x-encrypted-param-header',
    aeskey: key,
    rawsize: 1234,
    fileName: 'answer.md',
  })
  assert.equal(item.type, ITEM_FILE)
  assert.equal(item.file_item?.file_name, 'answer.md')
  // file len = RAW size as string (not ciphertext size)
  assert.equal(item.file_item?.len, '1234')
  assert.equal(item.file_item?.media?.full_url, undefined)
  assert.equal(item.file_item?.media?.encrypt_type, 1)
  assert.equal(item.file_item?.media?.aes_key?.length, 44)
})
