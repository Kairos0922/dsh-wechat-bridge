/**
 * Gateway helpers — pure functions exported from gateway/index.ts (F5).
 * No Context/credentials harness is required: these are self-contained.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { redactContextToken, redactItemForCapture } from '../src/gateway/index.ts'
import { ITEM_FILE, ITEM_IMAGE, ITEM_VIDEO, type MessageItem } from '../src/gateway/types.ts'

test('redactContextToken: keeps only the trailing 12 chars', () => {
  const full = '0123456789abcdefghijklmnopqrstuvwxyz'
  assert.equal(redactContextToken(full), full.slice(-12))
  // short tokens are returned whole (they cannot leak 12+ chars)
  assert.equal(redactContextToken('abc'), 'abc')
  assert.equal(redactContextToken(''), null)
  assert.equal(redactContextToken(undefined), null)
  assert.equal(redactContextToken(null), null)
})

test('redactItemForCapture: redacts AES keys in image/file/video layers', () => {
  const item: MessageItem = {
    type: ITEM_IMAGE,
    image_item: {
      aeskey: '0123456789abcdef0123456789abcdef',
      url: 'https://novac2c.cdn.weixin.qq.com/c2c/x',
      media: { aes_key: 'secret-aes-key', encrypt_query_param: 'encrypted-param', full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/full' },
      thumb_media: { aes_key: 'thumb-key' },
    },
  }
  const redacted = redactItemForCapture(item)
  // the ORIGINAL live object is untouched
  assert.equal(item.image_item?.aeskey, '0123456789abcdef0123456789abcdef')
  assert.equal(item.image_item?.media?.aes_key, 'secret-aes-key')
  // the copy carries redactions
  assert.equal(redacted.image_item?.aeskey, '<redacted>')
  assert.equal(redacted.image_item?.media?.aes_key, '<redacted>')
  assert.equal(redacted.image_item?.thumb_media?.aes_key, '<redacted>')
  // non-secret fields survive verbatim
  assert.equal(redacted.image_item?.url, 'https://novac2c.cdn.weixin.qq.com/c2c/x')
  assert.equal(redacted.image_item?.media?.encrypt_query_param, 'encrypted-param')
  assert.equal(redacted.image_item?.media?.full_url, 'https://novac2c.cdn.weixin.qq.com/c2c/full')
})

test('redactItemForCapture: file/voice/video media.aes_key redacted', () => {
  const item: MessageItem = {
    type: ITEM_FILE,
    file_item: { file_name: 'a.txt', len: '3', media: { aes_key: 'file-key' } },
  }
  const redacted = redactItemForCapture(item)
  assert.equal(redacted.file_item?.media?.aes_key, '<redacted>')
  assert.equal(redacted.file_item?.file_name, 'a.txt')
  assert.equal(item.file_item?.media?.aes_key, 'file-key', 'live object untouched')
})

test('redactItemForCapture: layerless items pass through unchanged', () => {
  const item: MessageItem = { type: ITEM_VIDEO, video_item: { video_size: 10 } }
  const redacted = redactItemForCapture(item)
  assert.deepEqual(redacted.video_item, { video_size: 10 })
})
