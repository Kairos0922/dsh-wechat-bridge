/**
 * iLink protocol client — self-contained, ported from Tencent/openclaw-weixin
 * (MIT, Copyright (C) 2026 Tencent). See LICENSE for attribution.
 *
 * Covers: authenticated POST/GET fetch wrappers, getUpdates long-poll,
 * sendMessage, getConfig, sendTyping, plus the QR login flow
 * (get_bot_qrcode / get_qrcode_status). CDN upload/download is added in M3.
 *
 * @module dsh-wechat-bridge/gateway/ilink-client
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InboundMessage, UpdatesBatch } from './types.ts'

export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_BOT_TYPE = '3'
export const DEFAULT_BOT_AGENT = 'dsh-wechat-bridge/0.1.0'

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_API_TIMEOUT_MS = 15_000
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000
export const QR_LONG_POLL_TIMEOUT_MS = 35_000

// ---------------------------------------------------------------- package meta

interface OwnPackageJson {
  name?: string
  version?: string
  ilink_appid?: string
}

/** Walk up from this module looking for our own package.json. */
function readOwnPackageJson(): OwnPackageJson {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    const { root } = path.parse(dir)
    while (dir && dir !== root) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as OwnPackageJson
        if (parsed.name === 'dsh-wechat-bridge') return parsed
      }
      dir = path.dirname(dir)
    }
  } catch {
    // fall through
  }
  return {}
}

const pkg = readOwnPackageJson()
const ILINK_APP_ID: string = pkg.ilink_appid ?? 'bot'
const CHANNEL_VERSION: string = pkg.version ?? 'unknown'

/** iLink-App-ClientVersion: uint32 0x00MMNNPP from the package version. */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(CHANNEL_VERSION)

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: DEFAULT_BOT_AGENT,
  }
}

// ---------------------------------------------------------------- headers

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function buildHeaders(opts: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`
  }
  return headers
}

// ---------------------------------------------------------------- fetch wrappers

async function apiPostFetch(params: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs?: number
  abortSignal?: AbortSignal
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined
  const timer =
    controller !== undefined && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined
  const onExternalAbort = () => controller?.abort()
  params.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders({ token: params.token }),
      body: params.body,
      signal: controller?.signal,
    })
    if (timer !== undefined) clearTimeout(timer)
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`POST ${params.endpoint} status=${res.status}: ${rawText.slice(0, 200)}`)
    }
    return rawText
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    params.abortSignal?.removeEventListener('abort', onExternalAbort)
  }
}

async function apiGetFetch(params: {
  baseUrl: string
  endpoint: string
  timeoutMs?: number
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined
  const timer =
    controller !== undefined && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: controller?.signal,
    })
    if (timer !== undefined) clearTimeout(timer)
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`GET ${params.endpoint} status=${res.status}: ${rawText.slice(0, 200)}`)
    }
    return rawText
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- messaging API

export interface GetUpdatesParams {
  baseUrl: string
  token?: string
  getUpdatesBuf?: string
  timeoutMs?: number
  abortSignal?: AbortSignal
}

/**
 * Long-poll getUpdates. On client-side timeout, returns an empty batch
 * (ret=0) so the caller can simply retry — normal for long-poll.
 */
export async function getUpdates(params: GetUpdatesParams): Promise<UpdatesBatch> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      abortSignal: params.abortSignal,
    })
    return JSON.parse(rawText) as UpdatesBatch
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
    }
    throw err
  }
}

export interface SendMessageBody {
  to_user_id: string
  context_token?: string
  item_list: Array<{ type: number; text_item?: { text?: string } }>
}

/** Send a single text message downstream. Returns the parsed response. */
export async function sendMessage(params: {
  baseUrl: string
  token?: string
  body: SendMessageBody
  timeoutMs?: number
}): Promise<{ ret?: number; errcode?: number; errmsg?: string }> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    // Wire format wraps the message in a `msg` object (SendMessageReq).
    body: JSON.stringify({ msg: params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  })
  const resp = JSON.parse(rawText) as { ret?: number; errcode?: number; errmsg?: string }
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errcode=${resp.errcode ?? '-'} errmsg=${resp.errmsg ?? '(none)'}`)
  }
  return resp
}

/** Fetch bot config (includes the typing ticket) for a given user. */
export async function getConfig(params: {
  baseUrl: string
  token?: string
  ilinkUserId: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ ret: number; typing_ticket?: string; errcode?: number; errmsg?: string }> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  })
  return JSON.parse(rawText) as { ret: number; typing_ticket?: string; errcode?: number; errmsg?: string }
}

/** Send a typing indicator. */
export async function sendTyping(params: {
  baseUrl: string
  token?: string
  ilinkUserId: string
  typingTicket: string
  status: 1 | 2
  timeoutMs?: number
}): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  })
}

// ---------------------------------------------------------------- QR login flow

export interface QrCodeResponse {
  qrcode: string
  qrcode_img_content?: string
}

export type QrLoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QrStatusResponse {
  status: QrLoginStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

/** Request a login QR code (bot_type 3, the standard WeChat channel). */
export async function fetchQrCode(params: {
  baseUrl?: string
  botType?: string
  timeoutMs?: number
}): Promise<QrCodeResponse> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl ?? LOGIN_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType ?? DEFAULT_BOT_TYPE)}`,
    body: JSON.stringify({}),
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  })
  return JSON.parse(rawText) as QrCodeResponse
}

/**
 * Long-poll the QR status. Network errors and client-side timeouts degrade
 * to `wait` so the caller keeps polling.
 */
export async function pollQrStatus(params: {
  baseUrl?: string
  qrcode: string
  verifyCode?: string
  timeoutMs?: number
}): Promise<QrStatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
    if (params.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
    }
    const rawText = await apiGetFetch({
      baseUrl: params.baseUrl ?? LOGIN_BASE_URL,
      endpoint,
      timeoutMs: params.timeoutMs ?? QR_LONG_POLL_TIMEOUT_MS,
    })
    return JSON.parse(rawText) as QrStatusResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' }
    }
    return { status: 'wait' }
  }
}
