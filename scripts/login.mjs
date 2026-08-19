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
  timeoutMs: 30 * 60_000,
  qrPollIntervalMs: 1500,
  onQr: (qr) => {
    fs.mkdirSync(stateDir, { recursive: true })
    const svgPath = path.join(stateDir, 'qr.svg')
    void (async () => {
      try {
        const { default: QRCode } = await import('qrcode')
        const svg = await QRCode.toString(qr.scanData, { type: 'svg', margin: 2, width: 480 })
        fs.writeFileSync(svgPath, svg)
        console.log(`📱 二维码已生成: ${svgPath}`)
        const { execSync } = await import('node:child_process')
        try {
          execSync(`open "${svgPath}"`)
          console.log('   已尝试在浏览器中自动打开，请用手机微信扫码并确认。\n')
        } catch {
          console.log('   请用浏览器打开上面的文件，用手机微信扫码并确认。\n')
        }
      } catch (err) {
        // 不打印 qr.scanData：扫码内容即登录授权链接，落进终端日志/截图任何人都能替你配对。
        console.log(`二维码生成失败（${String(err)}）。请确认 qrcode 依赖已安装后重试。\n`)
      }
    })()
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
