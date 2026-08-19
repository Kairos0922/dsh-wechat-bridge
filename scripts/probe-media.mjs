#!/usr/bin/env node
/**
 * ⚠️⚠️⚠️  生产通道探针 —— 使用前必须阅读  ⚠️⚠️⚠️
 *
 * 本脚本会对**生产微信账号**发送真实消息。教训（2026-08-16）：
 * 无许可的连续探针导致旧 bot 身份发送路径被服务器封禁（prepare failed，
 * 重新扫码配对才恢复）。规矩：
 *   1. 仅能在用户明确同意的测试窗口内运行；
 *   2. 任何非 dry 发送必须带 --consent；
 *   3. 每个窗口最多 1-2 条发送，异常立即停止；
 *   4. 实验前先只读确认通道健康（/api/dsh-wechat-bridge/status = polling）。
 *
 * probe-media.mjs — bot→WeChat 外发媒体（图片/文件）的端到端探针。
 *
 * 用生产同款 BUILT 产物（lib/）跑真实链路：getUploadUrl → AES-128-ECB → CDN 上传
 * → sendMessage。不启动轮询（不抢 iLink 单轮询锁）、不读生产状态、不打扰运行中的桥。
 * 每个步骤的服务器返回原样打印；`--verify` 追加服务器侧自下载闭环（下载→解密→比对 md5）。
 *
 * 形状变体：
 *   --shape current  (默认) 生产代码形状（= 官方形状，2026-08-17 端上验证通过）：
 *                            encrypt_query_param=CDN 响应 x-encrypted-param + aes_key=base64(hex 字符串,44字符)
 *                            + encrypt_type:1 + mid_size（buildOutboundMediaItem 组装）
 *   --shape official       历史形状（2026-08-16 入站抓取）：xep + base64(原始16字节,24字符) + full_url + aeskey(hex)
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
  encodeMediaAesKey,
  encryptAesEcb,
  md5Hex,
  randomHex,
  uploadBufferToCdn,
} from '../lib/gateway/upload.js'
import { decryptAesEcb } from '../lib/gateway/media.js'
import { pathToFileURL } from 'node:url'
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
  return pngFromRaw(makeTestRaw(w, h), w, h)
}

/** Raw RGB scanlines (filter byte 0 + RGB), the source for PNG + thumb. */
function makeTestRaw(w, h) {
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
  return raw
}

/** Encode raw RGB scanlines (w*h, filter byte 0 per row) as a PNG. */
function pngFromRaw(raw, w, h) {
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

/** 2x2-box downscale of raw RGB scanlines → (tw x th) raw, filter byte 0 per row. */
function downscaleRaw(raw, w, h, f) {
  const tw = Math.floor(w / f)
  const th = Math.floor(h / f)
  const out = Buffer.alloc(th * (1 + tw * 3))
  for (let y = 0; y < th; y++) {
    const row = y * (1 + tw * 3)
    out[row] = 0
    for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const sy = y * f + dy
          const sx = x * f + dx
          if (sy >= h || sx >= w) continue
          const off = sy * (1 + w * 3) + 1 + sx * 3
          r += raw[off]; g += raw[off + 1]; b += raw[off + 2]; n += 1
        }
      }
      const off = row + 1 + x * 3
      out[off] = Math.round(r / n)
      out[off + 1] = Math.round(g / n)
      out[off + 2] = Math.round(b / n)
    }
  }
  return { raw: out, tw, th }
}

/** Size-metadata mirroring the official client item (thumb sizes + hd_size). */
function sizeMetadataFor(image, w, h, ciphertextSize) {
  const f = 2
  const { raw: thumbRaw, tw, th } = downscaleRaw(makeTestRaw(w, h), w, h, f)
  const thumb = pngFromRaw(thumbRaw, tw, th)
  return {
    thumb_size: aesEcbPaddedSize(thumb.length),
    thumb_height: th,
    thumb_width: tw,
    hd_size: ciphertextSize,
  }
}

/** 320x240 → real phone-photo-like portrait (157x210) gradient. */
function makePortraitTestPng() {
  const w = 157, h = 210
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const off = row + 1 + x * 3
      raw[off] = Math.round((x / w) * 200) + 30
      raw[off + 1] = 70 + Math.round((y / h) * 90)
      raw[off + 2] = Math.round((y / h) * 230) + 20
    }
  }
  return pngFromRaw(raw, w, h)
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
    else if (a === '--hermes-flow') args.hermesFlow = true
    else if (a === '--envelope-matrix') args.envelopeMatrix = true
    else if (a === '--consent') args.consent = true
    else if (a === '--size-metadata') args.sizeMetadata = true
  }
  if (!['current', 'official', 'official-exact', 'mirror'].includes(args.shape)) {
    throw new Error(`unknown --shape '${args.shape}' (current|official|official-exact|mirror)`)
  }
  return args
}

/** Build the ImageItem — shape A via the production assembler, shape B manually (official capture). */
function buildImageItem({ shape, uploadParam, xep, aeskey, cdnBaseUrl, rawsize, filesize, itemFields, fields, noMidSize, encryptType, sizeMetadata, image, imageW, imageH }) {
  let item
  if (shape === 'current') {
    // 生产形状（2026-08-17 起 = 官方形状，端上已验证）:
    //   media = { encrypt_query_param: xep, aes_key: base64(hex)44字符, encrypt_type: 1 }
    //   image_item = { media, mid_size }；无 full_url、无 image_item.aeskey
    item = buildOutboundMediaItem({
      mediaType: UPLOAD_MEDIA_IMAGE,
      xep,
      aeskey,
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
  } else if (shape === 'official-exact') {
    // Tencent/openclaw-weixin sendImageMessageWeixin 逐字段镜像（v2.4.5）:
    //   media = { encrypt_query_param: <CDN 上传响应 x-encrypted-param>,
    //             aes_key: base64(HEX 字符串, 44字符), encrypt_type: 1 }
    //   image_item = { media, mid_size: 密文尺寸 }；无 full_url、无 image_item.aeskey
    const media = {
      encrypt_query_param: xep,
      aes_key: encodeMediaAesKey(aeskey),
      ...(encryptType !== null ? { encrypt_type: encryptType } : {}),
    }
    item = { type: ITEM_IMAGE, image_item: { media, mid_size: filesize } }
  } else {
    // mirror: 官方客户端入站抓取逐字段镜像（唯一差异 = 参数来源用服务器 upload_param）:
    //   image_item = { aeskey(hex), media: { encrypt_query_param, aes_key: 44字符, full_url } }
    //   无 mid_size、无 encrypt_type（与官方客户端出站 item 完全一致）
    const media = {
      encrypt_query_param: uploadParam,
      aes_key: encodeMediaAesKey(aeskey),
      full_url: `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(uploadParam)}`,
      ...(encryptType !== null ? { encrypt_type: encryptType } : {}),
    }
    item = { type: ITEM_IMAGE, image_item: { aeskey: aeskey.toString('hex'), media } }
  }
  const f = itemFields ? ['ct', 'ut', 'ic'] : (fields || [])
  if (f.includes('ct')) item.create_time_ms = Date.now()
  if (f.includes('ut')) item.update_time_ms = Date.now()
  if (f.includes('ic')) item.is_completed = true
  if (noMidSize && item.image_item) {
    delete item.image_item.mid_size
  }
  if (sizeMetadata && item.image_item) {
    // 官方客户端 item 的尺寸元数据（2026-08-16 完整捕获）:
    // thumb_size/thumb_height/thumb_width/hd_size —— 我们此前从未发送
    const meta = sizeMetadataFor(image, imageW, imageH, item.image_item.mid_size ?? filesize)
    Object.assign(item.image_item, meta)
  }
  return item
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dry && !args.consent) {
    console.error('✖ 拒绝执行：非 dry 模式必须带 --consent（用户明确同意测试窗口）。')
    console.error('  只读/不发送请加 --dry。')
    process.exit(2)
  }
  if (args.envelopeMatrix) {
    await runEnvelopeMatrix({ to: args.to, ctx: args.contextToken })
    return
  }
  if (args.hermesFlow) {
    await runHermesFlow(args)
    return
  }
  const creds = loadCredentials()
  const to = args.to
  if (!to) throw new Error('--to <userId> required (e.g. the allowlisted WeChat id)')

  const image = args.image ? fs.readFileSync(args.image) : (args.sizeMetadata ? makePortraitTestPng() : makeTestPng())
  const fileName = args.image ? path.basename(args.image) : 'probe.png'
  console.log(`▶ 探针: shape=${args.shape} itemFields=${args.itemFields} to=${to} bytes=${image.length} verify=${args.verify} dry=${args.dry}`)
  if (args.dry) {
    console.log('⏸ --dry：纯本地模式，不发起任何网络请求。')
    return
  }

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
    sizeMetadata: args.sizeMetadata,
    image,
    imageW: 157,
    imageH: 210,
  })
  console.log('③ item 形状 →', JSON.stringify({ type: item.type, media: item.image_item?.media, mid_size: item.image_item?.mid_size, aeskey: item.image_item?.aeskey ? `<redacted:${String(item.image_item.aeskey).length}字符>` : undefined }))
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
    // 实验性闭环：回源下载生产 CDN 属于带外探测，不在支持流程内；异常自行承担，勿据此改生产代码。
    console.log('⑤（实验性，不受支持）服务器侧自下载开始…')
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


// ---------------------------------------------------------------------------
// hermes-flow: 逐字段复刻 hermes-agent 0.19.0 gateway/platforms/weixin.py 的
// 完整外发流程（含信封/头/顺序），验证 prepare failed 是否由信封差异导致。
// 关键差异点：iLink-App-ClientVersion=2.2.0、base_info 仅 channel_version、
// caption 文本先行（独立消息）、媒体 item 用 CDN 上传响应 xep。
// ---------------------------------------------------------------------------

const HERMES_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0 // 2.2.0

function hermesHeaders(token, body, clientVersion) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(clientVersion ?? HERMES_CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function hermesApiPost({ baseUrl, endpoint, payload, token, clientVersion, botAgent }) {
  const baseInfo = { channel_version: '2.2.0', ...(botAgent ? { bot_agent: botAgent } : {}) }
  const body = JSON.stringify({ ...payload, base_info: baseInfo })
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, {
    method: 'POST',
    headers: hermesHeaders(token, body, clientVersion),
    body,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`hermes POST ${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
  return JSON.parse(raw)
}

/** 信封对照矩阵：纯文本 + getUploadUrl，验证服务器今天对信封字段的校验。 */
export async function runEnvelopeMatrix({ to, ctx }) {
  const creds = loadCredentials()
  const variants = [
    { label: 'hermes原封不动(2.2.0, 无bot_agent)', clientVersion: (2 << 16) | (2 << 8) | 0, botAgent: undefined },
    { label: 'hermes信封+bot_agent', clientVersion: (2 << 16) | (2 << 8) | 0, botAgent: 'dsh-wechat-bridge/0.1.0' },
    { label: '版本1.0.0+bot_agent', clientVersion: (1 << 16) | (0 << 8) | 0, botAgent: 'dsh-wechat-bridge/0.1.0' },
    { label: '版本0.1.0+bot_agent(我们现状)', clientVersion: (0 << 16) | (1 << 8) | 0, botAgent: 'dsh-wechat-bridge/0.1.0' },
  ]
  for (const v of variants) {
    const textResp = await hermesApiPost({
      baseUrl: creds.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      payload: {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: crypto.randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: '信封矩阵探针' } }],
          ...(ctx ? { context_token: ctx } : {}),
        },
      },
      token: creds.token,
      ...v,
    })
    const upResp = await hermesApiPost({
      baseUrl: creds.baseUrl,
      endpoint: 'ilink/bot/getuploadurl',
      payload: {
        filekey: randomHex(16),
        media_type: 1,
        to_user_id: to,
        rawsize: 5,
        rawfilemd5: md5Hex(Buffer.from('probe')),
        filesize: 16,
        no_need_thumb: true,
        aeskey: Buffer.from(randomHex(16), 'hex').toString('hex'),
      },
      token: creds.token,
      ...v,
    })
    console.log(`信封[${v.label}]: text=${JSON.stringify(textResp)} getUploadUrl=${JSON.stringify({ ret: upResp.ret, uploadParamLen: (upResp.upload_param ?? '').length })}`)
  }
}

async function sendHermesFlow({ creds, to, ctx, image, fileName, dry }) {
  // 1) caption 文本先行（hermes _send_file 语义：独立消息）
  if (!dry) {
    const captionResp = await hermesApiPost({
      baseUrl: creds.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      payload: {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: crypto.randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: `📎 ${fileName} (hermes-flow 探针)` } }],
          ...(ctx ? { context_token: ctx } : {}),
        },
      },
      token: creds.token,
    })
    console.log('H1 caption →', JSON.stringify(captionResp))
  }
  // 2) getUploadUrl（hermes 同字段）
  const filekey = randomHex(16)
  const aeskey = Buffer.from(randomHex(16), 'hex')
  const rawsize = image.length
  const filesize = aesEcbPaddedSize(rawsize)
  const slot = await hermesApiPost({
    baseUrl: creds.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    payload: {
      filekey,
      media_type: 1,
      to_user_id: to,
      rawsize,
      rawfilemd5: md5Hex(image),
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
    },
    token: creds.token,
  })
  console.log('H2 getUploadUrl →', JSON.stringify({ ret: slot.ret, uploadParamLen: (slot.upload_param ?? '').length }))
  if (slot.ret && slot.ret !== 0) throw new Error(`getUploadUrl ret=${slot.ret}`)
  // 3) CDN 上传（hermes _cdn_upload_url + POST）
  const uploadUrl = slot.upload_full_url?.trim() || `${creds.cdnBaseUrl.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(slot.upload_param)}&filekey=${encodeURIComponent(filekey)}`
  const ciphertext = encryptAesEcb(image, aeskey)
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  })
  const xep = upRes.headers.get('x-encrypted-param')
  console.log('H3 CDN 上传 →', upRes.status, 'xep 长度 =', xep?.length ?? 0)
  if (!xep) throw new Error('CDN upload missing x-encrypted-param')
  // 4) 媒体 item（hermes _outbound_media_builder 逐字段）
  const mediaItem = {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: xep,
        aes_key: Buffer.from(aeskey.toString('hex'), 'ascii').toString('base64'), // base64(hex字符串) 44字符
        encrypt_type: 1,
      },
      mid_size: ciphertext.length,
    },
  }
  console.log('H4 item →', JSON.stringify({ type: mediaItem.type, media: mediaItem.image_item.media, mid_size: mediaItem.image_item.mid_size }))
  if (dry) {
    console.log('⏸ --dry：不发送。')
    return
  }
  const resp = await hermesApiPost({
    baseUrl: creds.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    payload: {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [mediaItem],
        ...(ctx ? { context_token: ctx } : {}),
      },
    },
    token: creds.token,
  })
  console.log('H5 sendMessage →', JSON.stringify(resp))
  if (resp.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`)
  console.log('✅ hermes-flow ack。端上可见性 = 手机核对。')
}

export async function runHermesFlow(args) {
  const creds = loadCredentials()
  const to = args.to
  if (!to) throw new Error('--to <userId> required')
  const image = args.image ? fs.readFileSync(args.image) : (args.sizeMetadata ? makePortraitTestPng() : makeTestPng())
  const fileName = args.image ? path.basename(args.image) : 'probe.png'
  await sendHermesFlow({ creds, to, ctx: args.contextToken, image, fileName, dry: args.dry })
}

// 直接执行时跑 main；被 import 时仅暴露 runHermesFlow（供 hermes-flow 模式调用）
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirect) {
  main().catch((err) => {
    console.error('✖ 探针异常:', err)
    process.exit(1)
  })
}
