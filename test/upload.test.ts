/**
 * CDN upload + retention unit tests — pure functions, no network.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { aesEcbPaddedSize, buildCdnUploadUrl, encodeMediaAesKey, encryptAesEcb, md5Hex, randomHex } from '../src/gateway/upload.ts'
import { selectExpiredFiles } from '../src/node/retention.ts'
import { decryptAesEcb } from '../src/gateway/media.ts'

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
