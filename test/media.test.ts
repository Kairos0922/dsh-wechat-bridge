/**
 * Media crypto unit tests — pure functions, no network.
 */

import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import test from 'node:test'

import { decryptAesEcb, detectImageExt, downloadImage, parseAesKey } from '../src/gateway/media.ts'
import { MEDIA_DOWNLOAD_MAX_BYTES } from '../src/gateway/types.ts'

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

// ------------------------------------------------------------------ F4

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Build the encrypted body a server would return for a known plaintext. */
function encryptBody(plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', KEY, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Sequential-response fetch stub: each call pops the next response. */
function stubFetch(...responses: Response[]): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const queue = [...responses]
  const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input))
    const next = queue.shift()
    if (!next) throw new Error(`unexpected fetch: ${String(input)}`)
    return next
  }) as typeof fetch
  return { fetchFn, calls }
}

test('downloadImage: happy path decrypts and detects ext', async () => {
  const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03])
  const { fetchFn, calls } = stubFetch(new Response(new Uint8Array(encryptBody(plaintext)), { status: 200 }))
  const { data, ext } = await downloadImage({
    item: { aeskey: KEY.toString('hex'), url: `${CDN}/img` },
    fetchFn,
  })
  assert.ok(data.equals(plaintext))
  assert.equal(ext, 'jpg')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], `${CDN}/img`)
})

test('downloadImage: empty encrypt_query_param and no url throws BEFORE fetch', async () => {
  const { fetchFn, calls } = stubFetch()
  await assert.rejects(
    downloadImage({
      item: { media: { encrypt_query_param: '' }, aeskey: KEY.toString('hex') },
      fetchFn,
    }),
    /no url\/encrypt_query_param/,
  )
  assert.equal(calls.length, 0, 'fetch must never be called')
})

test('downloadImage: untrusted CDN host throws before fetch', async () => {
  const { fetchFn, calls } = stubFetch()
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: 'https://evil.com/x' }, fetchFn }),
    /host not trusted/,
  )
  assert.equal(calls.length, 0)
})

test('downloadImage: follows trusted 3xx redirects (max 3), re-validating each hop', async () => {
  const plaintext = Buffer.from('redirected payload')
  const { fetchFn, calls } = stubFetch(
    new Response(null, { status: 302, headers: { location: `${CDN}/hop1` } }),
    new Response(null, { status: 301, headers: { location: 'https://deep.cdn.weixin.qq.com/final' } }),
    new Response(new Uint8Array(encryptBody(plaintext)), { status: 200 }),
  )
  const { data } = await downloadImage({
    item: { aeskey: KEY.toString('hex'), media: { full_url: `${CDN}/start` } },
    fetchFn,
  })
  assert.ok(data.equals(plaintext))
  assert.deepEqual(calls, [`${CDN}/start`, `${CDN}/hop1`, 'https://deep.cdn.weixin.qq.com/final'])
})

test('downloadImage: redirect to an untrusted host throws', async () => {
  const { fetchFn } = stubFetch(new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } }))
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: `${CDN}/start` }, fetchFn }),
    /host not trusted/,
  )
})

test('downloadImage: more than 3 redirects throws', async () => {
  const { fetchFn } = stubFetch(
    new Response(null, { status: 302, headers: { location: `${CDN}/1` } }),
    new Response(null, { status: 302, headers: { location: `${CDN}/2` } }),
    new Response(null, { status: 302, headers: { location: `${CDN}/3` } }),
    new Response(null, { status: 302, headers: { location: `${CDN}/4` } }),
  )
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: `${CDN}/start` }, fetchFn }),
    /exceeded 3 redirects/,
  )
})

test('downloadImage: non-2xx final response throws', async () => {
  const { fetchFn } = stubFetch(new Response('boom', { status: 500, statusText: 'Internal Error' }))
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: `${CDN}/x` }, fetchFn }),
    /CDN download 500/,
  )
})

test('downloadImage: declared Content-Length over the cap throws before reading', async () => {
  const { fetchFn } = stubFetch(
    new Response(null, { status: 200, headers: { 'content-length': String(MEDIA_DOWNLOAD_MAX_BYTES + 1) } }),
  )
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: `${CDN}/big` }, fetchFn }),
    /too large/,
  )
})

test('downloadImage: streaming body over the cap throws mid-read', async () => {
  // No Content-Length header — the stream pump must still stop at the cap.
  const big = new Uint8Array(MEDIA_DOWNLOAD_MAX_BYTES + 1)
  const { fetchFn } = stubFetch(new Response(big, { status: 200 }))
  await assert.rejects(
    downloadImage({ item: { aeskey: KEY.toString('hex'), url: `${CDN}/stream` }, fetchFn }),
    /exceeded .* bytes/,
  )
})

test('downloadImage: extraTrustedHosts extends the trusted CDN set', async () => {
  const plaintext = Buffer.from('custom cdn payload')
  const { fetchFn } = stubFetch(new Response(new Uint8Array(encryptBody(plaintext)), { status: 200 }))
  const { data } = await downloadImage({
    item: { aeskey: KEY.toString('hex'), url: 'https://mycdn.example.com/x' },
    extraTrustedHosts: ['mycdn.example.com'],
    fetchFn,
  })
  assert.ok(data.equals(plaintext))
})

test('downloadImage: missing aes key throws after fetch', async () => {
  const { fetchFn } = stubFetch(new Response(new Uint8Array(encryptBody(Buffer.from('x'))), { status: 200 }))
  await assert.rejects(
    downloadImage({ item: { url: `${CDN}/x` }, fetchFn }),
    /no aes key/,
  )
})
