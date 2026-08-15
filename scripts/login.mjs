#!/usr/bin/env node
/**
 * CLI-driven QR login for dsh-wechat-bridge.
 *
 * Runs the iLink QR flow against the real gateway, writes the QR image to
 * plugins/dsh-wechat-bridge/state/qr.png (for GUI users), prints the QR URL
 * as a fallback, and persists the resulting credentials through the dsh
 * credentials service (`$DSH_HOME/.credentials.yaml` via dsh-credentials-local):
 * WEIXIN_ACCOUNT_ID / WEIXIN_BOT_TOKEN / WEIXIN_BASE_URL.
 *
 * Usage:  pnpm login        (from plugins/dsh-wechat-bridge)
 *         node scripts/login.mjs
 *
 * Requires a build first (`pnpm build`) since it imports `lib/`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { WechatGateway } from '../lib/gateway/index.js'

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const stateDir = path.join(pluginRoot, 'state')
const qrPngPath = path.join(stateDir, 'qr.png')

const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { watch: false })
await ctx.plugin(WechatGateway, {})

console.log('\n==============================================')
console.log(' dsh-wechat-bridge — iLink 微信登录')
console.log('==============================================\n')

const result = await ctx.wechat.loginQr({
  onQr: (qr) => {
    fs.mkdirSync(stateDir, { recursive: true })
    if (qr.imgContent) {
      try {
        fs.writeFileSync(qrPngPath, Buffer.from(qr.imgContent, 'base64'))
        console.log(`📱 二维码图片已保存: ${qrPngPath}`)
        console.log('   在访达中打开该图片，用手机微信扫码并确认。\n')
      } catch {
        // fall through to URL
      }
    }
    console.log(`二维码链接（备用，浏览器打开）: ${qr.scanData}\n`)
  },
  onStatus: (status) => {
    if (status === 'scaned') console.log('已扫码，请在微信里确认…')
    if (status === 'expired') console.log('二维码已过期，正在刷新…')
    if (status === 'need_verifycode') console.log('需要验证码，请在微信中完成验证后重试登录。')
    if (status === 'verify_code_blocked') console.log('验证码尝试过多被临时限制，请稍后再试。')
    if (status === 'binded_redirect') console.log('该微信已绑定过，沿用现有凭据。')
  },
})

if (!result.success) {
  console.error(`\n❌ 登录失败：${result.message}`)
  process.exit(1)
}

if (result.credentials) {
  const { accountId, botToken, baseUrl, ilinkUserId } = result.credentials
  const resolvedBaseUrl = baseUrl || 'https://ilinkai.weixin.qq.com'
  await ctx.credentials.set(credentialRef('WEIXIN_ACCOUNT_ID'), String(accountId))
  await ctx.credentials.set(credentialRef('WEIXIN_BOT_TOKEN'), String(botToken))
  await ctx.credentials.set(credentialRef('WEIXIN_BASE_URL'), resolvedBaseUrl)

  console.log(`\n✅ 登录成功！account_id=${accountId}`)
  if (ilinkUserId) {
    console.log(`   你的微信用户 id（配置 allowFrom 用）: ${ilinkUserId}`)
  }
  console.log('凭据已保存到 DSH credentials：WEIXIN_ACCOUNT_ID / WEIXIN_BOT_TOKEN / WEIXIN_BASE_URL')
  console.log('重启 dsh（或重载 profile）后，dsh-wechat-bridge 将自动开始轮询。')
} else {
  console.log(`\n✅ ${result.message}`)
}

await ctx.wechat.stop?.()
process.exit(0)
