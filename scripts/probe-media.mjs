#!/usr/bin/env node
/**
 * probe-media.mjs — bot→WeChat 外发媒体（图片/文件）的端到端探针。
 *
 * 用生产同款 BUILT 产物（lib/）跑真实链路：getUploadUrl → AES-128-ECB → CDN 上传
 * → sendMessage。不启动轮询（不抢 iLink 单轮询锁）、不读生产状态、不打扰运行中的桥。
 * 每个步骤的服务器返回原样打印；`--verify` 追加服务器侧自下载闭环（下载→解密→比对 md5）。
 *
 * 形状变体：
 *   --shape current  (默认) 生产代码形状：encrypt_query_param=upload_param + aes_key=base64(hex 字符串,44字符)
 *                            + full_url(绝对) + image_item.aeskey(hex)（buildOutboundMediaItem 组装）
 *   --shape official       官方客户端入站抓取形状：encrypt_query_param=CDN 响应 x-encrypted-param
 *                           + aes_key=base64(原始16字节,24字符) + full_url(绝对) + image_item.aeskey(hex)
 *
 * 矩阵记录：docs/porting-notes.md §6。判定边界：A/B 各一发，端上可见性以手机核对为准。
 *
 * 用法：
 *   node scripts/probe-media.mjs --shape current --to <userId> [--image <path>] [--file <path>] [--verify]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

import { getUploadUrl, sendMessage } from '../lib/gateway/ilink-client.js'
import {
  aesEcbPaddedSize,
  buildOutboundMediaItem,
  md5Hex,
  randomHex,
  uploadBufferToCdn,
} from '../lib/gateway/upload.js'
import { decryptAesEcb } from '../lib/gateway/media.js'
import {
  ITEM_IMAGE,
  UPLOAD_MEDIA_IMAGE,
  WEIXIN_CDN_BASE_URL,
} from '../lib/gateway/types.js'

const CREDS_PATH = path.join(os.homedir(), '.dsh', '.credentials.yaml')

function loadCredentials() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`credentials file not found: ${CREDS_PATH}`)
  const text = fs.readFileSync(CREDS_PATH, 'utf-8')
  const pick = (key) => {
    const m = new RegExp(`^${key}:\\s*(.+)\\s*$`, 'm').exec(text)
    return m ? m[1].trim() : undefined
  }
  const token = pick('WEIXIN_BOT_TOKEN')
  if (!token) throw new Error('WEIXIN_BOT_TOKEN missing in credentials')
  return {
    token,
    baseUrl: pick('WEIXIN_BASE_URL') || 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: WEIXIN_CDN_BASE_URL,
  }
}

// ---- minimal PNG generator (320x240 red→blue gradient, ~1KB) --------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makeTestPng(w = 320, h = 240) {
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const off = row + 1 + x * 3
      raw[off] = Math.round((x / w) * 255)
      raw[off + 1] = 64
      raw[off + 2] = Math.round((y / h) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function parseArgs(argv) {
  const args = { shape: 'current', verify: false, dry: false, itemFields: false, contextToken: undefined, image: undefined, file: undefined, to: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--shape') args.shape = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--image') args.image = argv[++i]
    else if (a === '--file') args.file = argv[++i]
    else if (a === '--verify') args.verify = true
    else if (a === '--dry') args.dry = true
    else if (a === '--item-fields') args.itemFields = true
    else if (a === '--fields') args.fields = (argv[++i] || '').split(',').filter(Boolean)
    else if (a === '--ctx') args.contextToken = argv[++i]
    else if (a === '--no-mid-size') args.noMidSize = true
    else if (a === '--encrypt-type') { const v = argv[++i]; args.encryptType = v === 'null' ? null : Number(v) }
  }
  if (!['current', 'official', 'official-exact'].includes(args.shape)) {
    throw new Error(`unknown --shape '${args.shape}' (current|official|official-exact)`)
  }
  return args
}

/** Build the ImageItem — shape A via the production assembler, shape B manually (official capture). */
function buildImageItem({ shape, uploadParam, xep, aeskey, cdnBaseUrl, rawsize, filesize, itemFields, fields, noMidSize, encryptType }) {
  let item
  if (shape === 'current') {
    item = buildOutboundMediaItem({
      mediaType: UPLOAD_MEDIA_IMAGE,
      uploadParam,
      aeskey,
      cdnBaseUrl,
      rawsize,
      fileName: 'probe.png',
    })
  } else if (shape === 'official') {
    // official-client shape (2026-08-16 入站抓取): xep 当引用 + base64(原始字节) key
    const media = {
      encrypt_query_param: xep,
      aes_key: aeskey.toString('base64'),
      full_url: `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(xep)}`,
    }
    item = { type: ITEM_IMAGE, image_item: { aeskey: aeskey.toString('hex'), media, mid_size: filesize } }
  } else {
    // official-exact: Tencent/openclaw-weixin sendImageMessageWeixin 逐字段镜像
    // (src/messaging/send.ts + src/cdn/upload.ts, v2.4.5):
    //   media = { encrypt_query_param: <CDN 上传响应 x-encrypted-param>,
    //             aes_key: base64(原始16字节, 24字符), encrypt_type: 1 }
    //   image_item = { media, mid_size: 密文尺寸 }
    // 无 full_url、无 image_item.aeskey、无 item 级字段
    const media = {
      encrypt_query_param: xep,
      aes_key: aeskey.toString('base64'),
      ...(encryptType !== null ? { encrypt_type: encryptType } : {}),
    }
    item = { type: ITEM_IMAGE, image_item: { media, mid_size: filesize } }
  }
  const f = itemFields ? ['ct', 'ut', 'ic'] : (fields || [])
  if (f.includes('ct')) item.create_time_ms = Date.now()
  if (f.includes('ut')) item.update_time_ms = Date.now()
  if (f.includes('ic')) item.is_completed = true
  if (noMidSize && item.image_item) {
    // 官方客户端 item 没有 mid_size（2026-08-16 入站抓取验证）
    delete item.image_item.mid_size
  }
  return item
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const creds = loadCredentials()
  const to = args.to
  if (!to) throw new Error('--to <userId> required (e.g. the allowlisted WeChat id)')

  const image = args.image ? fs.readFileSync(args.image) : makeTestPng()
  const fileName = args.image ? path.basename(args.image) : 'probe.png'
  console.log(`▶ 探针: shape=${args.shape} itemFields=${args.itemFields} to=${to} bytes=${image.length} verify=${args.verify}`)

  // ---- step 1: getUploadUrl ------------------------------------------------
  const filekey = randomHex(16)
  const aeskey = Buffer.from(randomHex(16), 'hex')
  const rawsize = image.length
  const filesize = aesEcbPaddedSize(rawsize)
  const slot = await getUploadUrl({
    baseUrl: creds.baseUrl,
    token: creds.token,
    filekey,
    mediaType: UPLOAD_MEDIA_IMAGE,
    toUserId: to,
    rawsize,
    rawfilemd5: md5Hex(image),
    filesize,
    aeskey: aeskey.toString('hex'),
  })
  console.log('① getUploadUrl →', JSON.stringify({ ret: slot.ret, errcode: slot.errcode, errmsg: slot.errmsg, uploadParamLen: slot.upload_param?.length ?? 0, hasUploadFullUrl: Boolean(slot.upload_full_url) }))
  if (slot.ret && slot.ret !== 0) {
    console.log('✖ getUploadUrl 失败，终止。')
    process.exit(1)
  }
  const uploadParam = slot.upload_param?.trim()
  if (!uploadParam) {
    console.log('✖ getUploadUrl 未返回 upload_param，终止。')
    process.exit(1)
  }

  // ---- step 2: AES-128-ECB → CDN 上传 --------------------------------------
  const { downloadParam: xep } = await uploadBufferToCdn({
    buf: image,
    uploadFullUrl: slot.upload_full_url,
    uploadParam: slot.upload_param,
    filekey,
    cdnBaseUrl: creds.cdnBaseUrl,
    aeskey,
  })
  console.log('② CDN 上传 → x-encrypted-param 长度 =', xep.length)

  // ---- step 3: sendMessage（形状 A 或 B） ------------------------------------
  const item = buildImageItem({
    shape: args.shape,
    uploadParam,
    xep,
    aeskey,
    cdnBaseUrl: creds.cdnBaseUrl,
    rawsize,
    filesize,
    itemFields: args.itemFields,
    fields: args.fields,
    noMidSize: args.noMidSize,
    encryptType: args.encryptType,
  })
  console.log('③ item 形状 →', JSON.stringify({ type: item.type, media: item.image_item?.media, mid_size: item.image_item?.mid_size, aeskey: item.image_item?.aeskey }))
  if (args.dry) {
    console.log('⏸ --dry：不发送，到此为止。')
    return
  }
  const resp = await sendMessage({
    baseUrl: creds.baseUrl,
    token: creds.token,
    body: { to_user_id: to, context_token: args.contextToken, item_list: [item] },
  })
  console.log('④ sendMessage →', JSON.stringify(resp))
  const delivered = resp.ret === undefined || resp.ret === 0
  console.log(delivered ? '✅ 服务器 ack（ret=0）。端上是否可见 = 手机核对（判定边界）。' : '✖ 服务器拒绝发送。')

  // ---- step 4 (optional): 服务器侧自下载闭环 ---------------------------------
  if (args.verify) {
    try {
      const url = item.image_item?.media?.full_url
      const fetched = await fetch(url)
      const buf = Buffer.from(await fetched.arrayBuffer())
      const plain = decryptAesEcb(buf, aeskey)
      console.log(`⑤ 自下载(${fetched.status}) → 解密 ${plain.length} 字节, md5 比对 ${md5Hex(plain) === md5Hex(image) ? '一致 ✅' : '不一致 ✖'}`)
    } catch (err) {
      console.log('⑤ 自下载失败 →', String(err))
    }
  }
}

main().catch((err) => {
  console.error('✖ 探针异常:', err)
  process.exit(1)
})
