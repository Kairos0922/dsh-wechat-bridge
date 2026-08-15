/**
 * Media crypto unit tests — pure functions, no network.
 */

import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import test from 'node:test'

import { decryptAesEcb, detectImageExt, parseAesKey } from '../src/gateway/media.ts'

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')

test('parseAesKey accepts a 32-char hex string', () => {
  assert.ok(parseAesKey('0123456789abcdef0123456789abcdef').equals(KEY))
})

test('parseAesKey accepts base64 of the raw 16 bytes', () => {
  assert.ok(parseAesKey(KEY.toString('base64')).equals(KEY))
})

test('parseAesKey accepts base64 of the hex string', () => {
  assert.ok(parseAesKey(Buffer.from(KEY.toString('hex'), 'ascii').toString('base64')).equals(KEY))
})

test('parseAesKey rejects garbage', () => {
  assert.throws(() => parseAesKey('not-a-key'))
})

test('detectImageExt sniffs magic bytes', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
  assert.equal(detectImageExt(jpg), 'jpg')
  assert.equal(detectImageExt(png), 'png')
  assert.equal(detectImageExt(webp), 'webp')
  assert.equal(detectImageExt(Buffer.from('plain text data')), 'bin')
})

test('decryptAesEcb roundtrips a 16-byte block', () => {
  // AES-128-ECB with PKCS7: decrypt a known vector produced by encrypting
  // 16 zero bytes under KEY.
  const cipher = createCipheriv('aes-128-ecb', KEY, null)
  const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()])
  const plain = decryptAesEcb(ciphertext, KEY)
  assert.equal(plain.length, 16)
  assert.ok(plain.equals(Buffer.alloc(16)))
})
