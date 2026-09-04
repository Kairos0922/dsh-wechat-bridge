/**
 * Web settings panel for dsh-wechat-bridge (differentiator #3):
 * gateway status, QR pairing, allowlist overview and mode list — all in the
 * DSH Web settings UI. No CLI QR juggling.
 *
 * Talks to the host half over same-origin endpoints
 * (`/api/dsh-wechat-bridge/status`, `/api/dsh-wechat-bridge/pair`).
 *
 * @module dsh-wechat-bridge/client
 */

import { createElement as h, useEffect, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'

const NS = 'settings.dshWechatBridge'

// ---------------------------------------------------------------- typing seam

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(name: string, registrant: () => unknown): void
      register(opts: Record<string, unknown>, component: unknown): unknown
    }
    locale: {
      register(ns: string, dict: Record<string, Record<string, string>>): () => void
      bind(ns: string): (key: string) => string
    }
  }
}

// ---------------------------------------------------------------- dictionaries

const zh = {
  tab: '微信桥',
  title: '微信控制 DSH',
  paired: '已配对',
  unpaired: '未配对',
  gatewayStatus: '网关状态',
  accountId: '账号 ID',
  allowFrom: '白名单（allowFrom）',
  modes: '可用模式',
  defaultMode: '默认模式',
  prefs: '桥内偏好（对 /new 生效）',
  prefsModel: '模型',
  prefsCwd: '工作区',
  prefsDefault: '跟随 DSH 默认',
  markdownMode: 'Markdown 策略',
  outbox: '出站队列',
  outboxPending: '{n} 条待发',
  outboxPaused: '限流暂停中',
  outboxIdle: '空闲',
  pair: '扫码配对',
  pairing: '配对中…请用微信扫码',
  pairHint: '二维码 5 分钟过期；过期后服务端会自动续期（扫码窗口内可继续）。',
  emptyAllowlist: '（空——需在 profile 配置中填写 allowFrom 才会应答消息）',
  helpTitle: '微信命令',
  help: [
    '/modes — 全部模式（中文说明 + 编号快捷）',
    '/new [模式] <prompt> — 新建会话',
    '/model · /workspace — 切换模型/工作区',
    '/use N / /sessions / /stop / /status',
    '/retry / /close / /help — 重试 / 归档 / 帮助',
    '/yes /no — 回应权限请求',
  ].join('\n'),
  requestFailed: '状态读取失败',
  pendingPairTitle: '⚠ 检测到不同的机器人身份',
  pendingPairBody: '扫码人 {id} 请求切换本桥接的凭证（账号 {account}）。确认将覆盖当前凭证；拒绝保持现状。',
  pendingTrustTitle: '新扫码用户待确认',
  pendingTrustBody: '扫码人 {id} 已完成配对，确认后加入信任名单并可使用本机器人；拒绝则不会被信任。',
  confirm: '确认',
  reject: '拒绝',
  pairedUsers: '已配对用户',
  revoke: '吊销',
  revokeHint: '吊销后对方立即失去访问权，其会话绑定与令牌一并清除。',
  verifyCodePrompt: '微信验证码',
  verifyCodeSubmit: '提交验证码',
  pause: '暂停桥接',
  resume: '恢复桥接',
  sessions: 'DSH 会话',
  sessionsHint: '允许微信操作后，电脑端和微信端可继续使用同一个会话。',
  sessionId: 'ID',
  sessionStatus: '状态',
  sessionActivity: '最近活动',
  sessionEnabled: '微信可操作',
  allowWechat: '允许微信操作',
  stopWechat: '停止微信访问',
  noSessions: '暂无可用 DSH 会话',
  sessionActionFailed: '会话权限更新失败',
}

const en = {
  tab: 'WeChat Bridge',
  title: 'Control DSH from WeChat',
  paired: 'Paired',
  unpaired: 'Not paired',
  gatewayStatus: 'Gateway status',
  accountId: 'Account ID',
  allowFrom: 'Allowlist (allowFrom)',
  modes: 'Available modes',
  defaultMode: 'Default mode',
  prefs: 'Bridge prefs (apply to /new)',
  prefsModel: 'Model',
  prefsCwd: 'Workspace',
  prefsDefault: 'Follow DSH default',
  markdownMode: 'Markdown policy',
  outbox: 'Outbound queue',
  outboxPending: '{n} pending',
  outboxPaused: 'Rate-limit pause',
  outboxIdle: 'Idle',
  pair: 'Pair via QR',
  pairing: 'Pairing… scan with WeChat',
  pairHint: 'The QR expires in 5 minutes; the server renews it automatically while the scan window is open.',
  emptyAllowlist: '(empty — fill allowFrom in the profile config to accept messages)',
  helpTitle: 'WeChat commands',
  help: [
    '/modes — all modes (annotated + numbered)',
    '/new [mode] <prompt> — create a session',
    '/model · /workspace — switch model/workspace',
    '/use N / /sessions / /stop / /status',
    '/retry / /close / /help — retry / archive / help',
    '/yes /no — answer permission requests',
  ].join('\n'),
  requestFailed: 'Failed to load status',
  pendingPairTitle: '⚠ A different bot identity scanned',
  pendingPairBody: 'Scanner {id} requests switching this bridge to account {account}. Confirm overwrites the current credentials; reject keeps them.',
  pendingTrustTitle: 'New scanner awaiting confirmation',
  pendingTrustBody: 'Scanner {id} finished pairing. Confirm to trust them with this bridge; reject to keep them untrusted.',
  confirm: 'Confirm',
  reject: 'Reject',
  pairedUsers: 'Paired users',
  revoke: 'Revoke',
  revokeHint: 'Revoking immediately cuts access and clears their session bindings and tokens.',
  verifyCodePrompt: 'WeChat verify code',
  verifyCodeSubmit: 'Submit code',
  pause: 'Pause bridge',
  resume: 'Resume bridge',
  sessions: 'DSH sessions',
  sessionsHint: 'When enabled, the same session can be continued from both desktop and WeChat.',
  sessionId: 'ID',
  sessionStatus: 'Status',
  sessionActivity: 'Recent activity',
  sessionEnabled: 'WeChat enabled',
  allowWechat: 'Allow WeChat access',
  stopWechat: 'Stop WeChat access',
  noSessions: 'No DSH sessions available',
  sessionActionFailed: 'Failed to update session access',
}

// ---------------------------------------------------------------- data

interface StatusMode {
  id: string
  name?: string
  description?: string
}

interface Status {
  ok: boolean
  status: string
  pairingMessage: string
  /** P0-1: gateway is waiting for the numeric verify code during pairing. */
  needVerifyCode?: boolean
  /** P1-6: bridge-level pause (inbound ignored, state preserved). */
  paused?: boolean
  paired: boolean
  accountId: string | null
  allowFrom: string[]
  modes: StatusMode[]
  defaultMode: string | null
  markdownMode: string
  prefs: { provider?: string; model?: string; cwd?: string }
  outbox: { pending: number; pausedUntil: number | null }
  lastSendError: { errcode?: number; errmsg?: string; at: number } | null
  /** P2-3: named-reason health snapshot (read-only). */
  health?: {
    reason: string
    issues: Array<{ reason: string; fix: string }>
    pollFailures: number
    lastInboundAt: number | null
    lastOutboundAt: number | null
  }
  pendingPair: { userId: string; accountId: string } | null
  pendingTrustUserId: string | null
  pairedUserIds: string[]
  sessions?: Array<{ id: string; label: string; status: string; lastActivityAt: number; enabled: boolean }>
}

function formatSessionActivity(at: number): string {
  if (!at) return '—'
  return new Date(at).toLocaleString()
}

function useStatus(): { status: Status | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<Status | null>(null)
  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/dsh-wechat-bridge/status')
      // A non-2xx or a non-`ok` body is NOT a valid Status (the host returns
      // { ok: false } on a 500). Accepting it would render `prefs`/`outbox`
      // as undefined and crash the panel — keep the last known state instead.
      if (!res.ok) return
      const data = (await res.json()) as Status
      if (data.ok !== true) return
      setStatus(data)
    } catch {
      // keep last known state
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [])
  return { status, refresh: load }
}

// ---------------------------------------------------------------- styles

const css: Record<string, CSSProperties> = {
  section: {
    width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14,
    color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 15, lineHeight: '22px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-2)', padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' },
  label: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
  value: { margin: 0, fontSize: 13, wordBreak: 'break-all' },
  pill: {
    display: 'inline-flex', borderRadius: 999, padding: '2px 10px', fontSize: 12,
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)', width: 'max-content',
  },
  pillError: {
    display: 'inline-flex', borderRadius: 999, padding: '2px 10px', fontSize: 12,
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)', width: 'max-content',
  },
  chip: {
    display: 'inline-block', borderRadius: 6, padding: '3px 8px', fontSize: 12,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
    margin: '2px 4px 2px 0',
  },
  button: {
    height: 36, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', padding: '0 12px', cursor: 'pointer',
  },
  input: {
    height: 36, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', padding: '0 10px', width: 140,
  },
  qr: { width: 240, height: 240, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10 },
  pre: {
    margin: 0, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'pre-wrap',
  },
  error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 },
}

// ---------------------------------------------------------------- component

function WechatBridgePanel(props: { t: (key: string) => string }) {
  const { t } = props
  const { status, refresh } = useStatus()
  const [qr, setQr] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verifyCode, setVerifyCode] = useState('')

  const pair = async (): Promise<void> => {
    setError(null)
    setPairing(true)
    try {
      const res = await fetch('/api/dsh-wechat-bridge/pair', { method: 'POST' })
      const data = (await res.json()) as { ok: boolean; svg?: string; error?: string }
      if (!data.ok || !data.svg) throw new Error(data.error ?? 'pair failed')
      setQr(data.svg)
    } catch (err) {
      setError(String(err))
      setPairing(false)
    }
  }

  /** POST a pairing-management action and re-poll the status afterwards. */
  const action = async (path: string, body?: Record<string, unknown>): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? 'action failed')
      await refresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const svgDataUrl = qr
    ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(qr)))}`
    : null

  return h(
    'section',
    { style: css.section },
    h('div', { style: css.row },
      h('h3', { style: css.title }, t('title')),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        status?.paired
          ? h('span', { style: css.pill }, t('paired'))
          : h('span', { style: css.pillError }, t('unpaired')),
        // P1-6: bridge-level pause switch — inbound is dropped while paused,
        // credentials/queue/sessions preserved.
        h('button', {
          style: css.button,
          disabled: busy,
          onClick: () => void action('/api/dsh-wechat-bridge/pause', { paused: !status?.paused }),
        }, status?.paused ? t('resume') : t('pause')),
      ),
    ),
    h('div', { style: css.card },
      h('div', null,
        h('span', { style: css.label }, `${t('gatewayStatus')} · ${status?.status ?? '…'}`),
        status?.pairingMessage ? h('p', { style: css.muted }, status.pairingMessage) : null,
        // P0-1: numeric verify code entry — the server demands a code shown
        // in the scanning WeChat client before the pairing can confirm.
        status?.needVerifyCode
          ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
              h('input', {
                style: css.input,
                value: verifyCode,
                placeholder: t('verifyCodePrompt'),
                onInput: (e: { target: { value: string } }) => setVerifyCode(e.target.value),
              }),
              h('button', {
                style: css.button,
                disabled: busy || !verifyCode.trim(),
                onClick: () => {
                  void action('/api/dsh-wechat-bridge/pair/verify-code', { code: verifyCode.trim() })
                  setVerifyCode('')
                },
              }, t('verifyCodeSubmit')),
            )
          : null,
      ),
      h('div', null,
        h('span', { style: css.label }, t('accountId')),
        h('p', { style: css.value }, status?.accountId ?? '—'),
      ),
      h('div', null,
        h('span', { style: css.label }, t('allowFrom')),
        h('div', null,
          (status?.allowFrom ?? []).length > 0
            ? status!.allowFrom.map((id) => h('span', { key: id, style: css.chip }, id))
            : h('p', { style: css.muted }, t('emptyAllowlist')),
        ),
      ),
      h('div', null,
        h('span', { style: css.label }, `${t('modes')}${status?.defaultMode ? ` · ${t('defaultMode')}: ${status.defaultMode}` : ''}`),
        h('div', null,
          (status?.modes ?? []).length > 0
            ? status!.modes.map((mode) =>
                h('span', { key: mode.id, style: css.chip, title: mode.description ?? undefined }, mode.name && mode.name !== mode.id ? `${mode.name}（${mode.id}）` : mode.id),
              )
            : h('p', { style: css.muted }, '—'),
        ),
      ),
      h('div', null,
        h('span', { style: css.label }, `${t('prefs')} · ${t('markdownMode')}: ${status?.markdownMode ?? '…'}`),
        h('p', { style: css.muted },
          `${t('prefsModel')}: ${status?.prefs?.provider && status.prefs.model ? `${status.prefs.provider}/${status.prefs.model}` : t('prefsDefault')}` +
          ` · ${t('prefsCwd')}: ${status?.prefs?.cwd ?? t('prefsDefault')}`,
        ),
      ),
      h('div', null,
        h('span', { style: css.label }, t('outbox')),
        h('p', { style: css.muted },
          status?.outbox?.pausedUntil
            ? `${t('outboxPaused')}（${Math.max(1, Math.round((status.outbox.pausedUntil - Date.now()) / 1000))}s）`
            : status?.outbox?.pending
              ? t('outboxPending').replace('{n}', String(status.outbox.pending))
              : t('outboxIdle'),
        ),
      ),
      status?.lastSendError
        ? h('p', { style: css.muted }, `⚠ ${t('requestFailed')}: errcode=${status.lastSendError.errcode ?? '-'} ${status.lastSendError.errmsg ?? ''}`)
        : null,
      // P2-3: named-reason health line + actionable fix hints (read-only
      // self-check — the status poll itself is the probe, nothing is sent).
      status?.health && status.health.reason !== 'healthy'
        ? h('div', null,
            h('span', { style: css.label }, `🩺 ${status.health.reason}`),
            (status.health.issues ?? []).map((issue, idx) =>
              h('p', { key: idx, style: css.muted }, `↳ ${issue.fix}`),
            ),
          )
        : null,
    ),
    // Held bot-identity switch: the gateway refuses to overwrite credentials
    // until a human confirms here (empty trust set auto-confirms host-side).
    status?.pendingPair
      ? h('div', { style: { ...css.card, border: '1px solid var(--dsw-alias-state-error-primary)' } },
          h('h4', { style: css.title }, t('pendingPairTitle')),
          h('p', { style: css.muted },
            t('pendingPairBody').replace('{id}', status.pendingPair.userId).replace('{account}', status.pendingPair.accountId || '—'),
          ),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/pair/confirm') }, t('confirm')),
            h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/pair/reject') }, t('reject')),
          ),
        )
      : null,
    // New scanner held for operator confirmation (trust set was non-empty).
    status?.pendingTrustUserId
      ? h('div', { style: { ...css.card, border: '1px solid var(--dsw-alias-state-error-primary)' } },
          h('h4', { style: css.title }, t('pendingTrustTitle')),
          h('p', { style: css.muted }, t('pendingTrustBody').replace('{id}', status.pendingTrustUserId)),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/pair/confirm') }, t('confirm')),
            h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/pair/reject') }, t('reject')),
          ),
        )
      : null,
    h('div', { style: css.card },
      h('div', { style: css.row },
        h('h4', { style: css.title }, t('sessions')),
      ),
      h('p', { style: css.muted }, t('sessionsHint')),
      (status?.sessions ?? []).length > 0
        ? status!.sessions!.map((session) => h('div', { key: session.id, style: { ...css.row, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('strong', { style: { display: 'block', fontSize: 13 } }, session.label),
              h('p', { style: css.muted }, `${t('sessionId')}: ${session.id}`),
              h('p', { style: css.muted }, `${t('sessionStatus')}: ${session.status} · ${t('sessionActivity')}: ${formatSessionActivity(session.lastActivityAt)}`),
            ),
            h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/session-access', { sessionId: session.id, enabled: !session.enabled }) }, session.enabled ? t('stopWechat') : t('allowWechat')),
          ))
        : h('p', { style: css.muted }, t('noSessions')),
    ),
    h('div', { style: css.card },
      h('div', { style: css.row },
        h('h4', { style: css.title }, t('pair')),
        h('button', { style: css.button, onClick: () => void pair(), disabled: pairing }, pairing ? t('pairing') : t('pair')),
      ),
      svgDataUrl ? h('img', { src: svgDataUrl, style: css.qr, alt: 'WeChat QR' }) : null,
      h('p', { style: css.muted }, t('pairHint')),
      error ? h('p', { style: css.error }, `${t('requestFailed')}: ${error}`) : null,
    ),
    // Paired users with one-click revocation.
    (status?.pairedUserIds ?? []).length > 0
      ? h('div', { style: css.card },
          h('h4', { style: css.title }, t('pairedUsers')),
          h('div', null,
            status!.pairedUserIds.map((id) =>
              h('div', { key: id, style: css.row },
                h('span', { style: css.chip }, id),
                h('button', { style: css.button, disabled: busy, onClick: () => void action('/api/dsh-wechat-bridge/pair/revoke', { userId: id }) }, t('revoke')),
              ),
            ),
          ),
          h('p', { style: css.muted }, t('revokeHint')),
        )
      : null,
    h('div', { style: css.card },
      h('h4', { style: css.title }, t('helpTitle')),
      h('pre', { style: css.pre }, t('help')),
    ),
  )
}

// ---------------------------------------------------------------- plugin

const inject = ['slots', 'locale'] as const

function apply(ctx: Context): void {
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh, en })
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'dsh-wechat-bridge',
        order: 30,
        label: () => t('tab'),
        locale: NS,
        inject: () => ({ t }),
      },
      WechatBridgePanel,
    ),
  )
}

// No `export default`: the loader's unwrapExports picks `default` first and
// drops the module-level `inject` export, which breaks service injection
// ("cannot get property ... without inject"). Official client bundles also
// export only named apply/inject — as a trailing named list, the form the
// wrap script (scripts/wrap-client.mjs) converts into exports assignments.
export { inject, apply }
