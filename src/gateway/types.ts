/**
 * iLink protocol types shared by the gateway and the bridge node.
 *
 * Field names follow the official openclaw-weixin backend protocol
 * (Tencent/openclaw-weixin, MIT) — see README.zh.md for the protocol table.
 *
 * @module dsh-wechat-bridge/gateway/types
 */

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export const LONG_POLL_TIMEOUT_MS = 35_000
export const API_TIMEOUT_MS = 15_000
export const MESSAGE_DEDUP_TTL_SECONDS = 300
export const MAX_MESSAGE_CHARS = 2000

/** iLink errcodes (from the official backend protocol). */
export const RATE_LIMIT_ERRCODE = -12
export const SESSION_EXPIRED_ERRCODE = -14

export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

export const MESSAGE_TYPE_USER = 1
export const MESSAGE_TYPE_BOT = 2

export interface TextItem {
  text?: string
}

export interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  /** 加密类型: 0=只加密fileid, 1=打包缩略图/中图等信息 */
  encrypt_type?: number
  /** 完整下载 URL（服务端直接返回，无需客户端拼接） */
  full_url?: string
}

export interface ImageItem {
  /** 原图 CDN 引用 */
  media?: CdnMedia
  /** 缩略图 CDN 引用 */
  thumb_media?: CdnMedia
  /** Raw AES-128 key as hex string (16 bytes); preferred for inbound decryption. */
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface MessageItem {
  type: number
  text_item?: TextItem
  image_item?: ImageItem
  ref_msg?: unknown
}

export interface InboundMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
}

export interface UpdatesBatch {
  ret: number
  errcode?: number
  errmsg?: string
  msgs?: InboundMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface WechatCredentials {
  accountId?: string
  botToken?: string
  baseUrl?: string
  /** WeChat user id of the account that scanned the login QR. */
  ilinkUserId?: string
}

/** Payload emitted by the gateway on `inbound` (scoped to the `wechat` service). */
export interface InboundEvent {
  message: InboundMessage
  senderId: string
  contextToken?: string
}
