/**
 * WeChat command vocabulary, registry-driven.
 *
 * One registry is the single source of truth for every command: `/help`
 * renders from it (nothing can fall out of date), unknown commands fall back
 * to it. Numbered choice menus (mode/model/workspace) are registered with the
 * node so bare-number replies resolve against the open menu — no more typing
 * than a tap on mobile.
 *
 * @module dsh-wechat-bridge/node/commands
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WechatBridgeNode } from './core.ts'
import { listModes, type ModeInfo } from './presets.ts'
import { sendTextToPeer, textOfAssistantMessage } from './outbound.ts'
import { buildTranscript, exportsDir, writeExportFile } from './exports.ts'
import { renderCardToPng } from './card.ts'

/** The active session's first user prompt, for list labels. */
function sessionLabel(session: Session): string {
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const blocks = event.data.content as unknown as Array<{ type: string; text?: string }>
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(' ')
        .trim()
      if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text
    }
  }
  return '(空会话)'
}

/** Sessions ordered most-recent-first. */
export function listSessions(node: WechatBridgeNode): Session[] {
  return [...node.ctx.sessions.list()].sort((a, b) => {
    const diff = b.header.createdAt - a.header.createdAt
    if (diff !== 0) return diff
    return b.seq - a.seq
  })
}

/** Parse `/new` arguments: an optional mode (matching a discovered preset). */
export async function parseNewArgs(
  node: WechatBridgeNode,
  rest: string[],
): Promise<{ mode?: string; prompt: string }> {
  const first = rest[0] ?? ''
  if (first) {
    const modes = await listModes(node.ctx)
    if (modes.some((m) => m.id === first)) {
      return { mode: first, prompt: rest.slice(1).join(' ').trim() }
    }
  }
  return { prompt: rest.join(' ').trim() }
}

// ---------------------------------------------------------------- registry

export interface CommandSpec {
  id: string
  /** One line for `/help`. */
  summary: string
  usage: string
  /** Detail block for `/help <cmd>`. */
  detail: string
  run(node: WechatBridgeNode, peerId: string, args: string[]): Promise<void>
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * Compact `/modes` rendering: one line per mode (name + id + short
 * annotation). The per-mode `/new <id>` lines were dropped — WeChat copies
 * whole bubbles, so they never enabled selective copying; the numbered-reply
 * menu is the primary path and `/new <id>` stays documented in `/help`.
 */
export function renderModesList(modes: ModeInfo[], defaultMode?: string, menuTimeoutSec = 60): string {
  const minutes = Math.max(1, Math.round(menuTimeoutSec / 60))
  const lines = modes.map((m, i) => {
    const name = m.name ?? m.id
    const marker = m.id === defaultMode ? ' · 默认' : ''
    const desc = m.description ? ` — ${truncate(m.description.replace(/\s+/g, ' '), 22)}` : ''
    return `${i + 1}. ${name}（${m.id}）${marker}${desc}`
  })
  return [`🎭 模式（回复编号直接创建，${minutes} 分钟有效）`, ...lines, '/new <id> 手动创建 · /help 全部命令'].join('\n')
}

export const COMMANDS: CommandSpec[] = [
  {
    id: 'modes',
    summary: '列出全部模式（中文说明 + 快捷命令）',
    usage: '/modes',
    detail: '列出所有可用的 agent 模式（预设），每行一行：中文名（id）+ 一句话说明。回复编号直接以该模式创建新会话（菜单 60 秒有效），或 /new <id> 手动创建。',
    run: async (node, peerId) => {
      const modes = await listModes(node.ctx)
      if (modes.length === 0) {
        await sendTextToPeer(node, peerId, '📭 没有发现任何 agent 预设（$DSH_HOME/.agent-presets 为空）。', { kind: 'system' })
        return
      }
      node.registerMenu(
        peerId,
        'mode',
        modes.map((m) => ({ label: m.name ?? m.id, value: m.id })),
      )
      await sendTextToPeer(node, peerId, renderModesList(modes, node.resolved.defaultMode, node.resolved.menuTimeoutSec), {
        kind: 'system',
      })
    },
  },
  {
    id: 'new',
    summary: '按模式新建会话并开始',
    usage: '/new [模式] <prompt>',
    detail: '新建一个会话：第一个词是模式 id（可选，缺省用 defaultMode 配置），其余作为第一条任务。例：/new 代码助手 帮我写个冒泡排序。',
    run: async (node, peerId, args) => {
      const { mode, prompt } = await parseNewArgs(node, args)
      await node.createSession(peerId, prompt, mode)
    },
  },
  {
    id: 'sessions',
    summary: '列出我的会话（/use N 切换）',
    usage: '/sessions',
    detail: '列出由你（当前微信）创建的会话，最近的在最前。/use N 切换到第 N 个。',
    run: async (node, peerId) => {
      const sessions = node.sessionsForPeer(peerId)
      if (sessions.length === 0) {
        await sendTextToPeer(node, peerId, '📋 你还没有会话。发送 /new [模式] <prompt> 开始。', { kind: 'system' })
        return
      }
      const activeId = node.activeSession(peerId)?.id
      const lines = sessions.map((session, i) => {
        const marker = session.id === activeId ? ' ▶' : ''
        return `${i + 1}. ${sessionLabel(session)} — ${session.id}${marker}`
      })
      await sendTextToPeer(node, peerId, `📋 你的会话（/use N 切换）\n${lines.join('\n')}`, { kind: 'system' })
    },
  },
  {
    id: 'use',
    summary: '切换到会话 N',
    usage: '/use <N>',
    detail: '切换到 /sessions 列表中的第 N 个会话，之后的普通消息都发给它。',
    run: async (node, peerId, args) => {
      const index = Number(args[0])
      const sessions = node.sessionsForPeer(peerId)
      if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
        await sendTextToPeer(node, peerId, `❌ 无效编号。可用: 1–${sessions.length}（/sessions 查看列表）`, { kind: 'system' })
        return
      }
      const session = sessions[index - 1]!
      node.setActiveSession(peerId, session.id)
      await sendTextToPeer(node, peerId, `✅ 已切换到会话 #${index}（${session.id}）`, { kind: 'system' })
    },
  },
  {
    id: 'stop',
    summary: '停止当前任务',
    usage: '/stop',
    detail: '请求取消当前会话正在运行的回合（不影响历史）。',
    run: async (node, peerId) => {
      const agent = node.activeAgent(peerId)
      if (!agent) {
        await sendTextToPeer(node, peerId, '❌ 没有活动的 agent', { kind: 'system' })
      } else {
        agent.cancel({ kind: 'user' })
        await sendTextToPeer(node, peerId, '⏹ 已请求停止', { kind: 'system' })
      }
    },
  },
  {
    id: 'status',
    summary: '查看会话与偏好状态',
    usage: '/status',
    detail: '当前会话、agent 运行状态、模型/工作区偏好、出站队列与限流状态。',
    run: async (node, peerId) => {
      const session = node.activeSession(peerId)
      if (!session) {
        await sendTextToPeer(node, peerId, '💤 没有活动会话。发送 /new [模式] <prompt> 开始，/modes 查看可用模式。', { kind: 'system' })
        return
      }
      const agent = node.activeAgent(peerId)
      const lastTurn = [...session.events].reverse().find((e) => e.type === 'turn/end')
      const reason = lastTurn ? describeTurnEnd(lastTurn.data.reason) : '尚未运行'
      const prefs = node.state.getPrefs(peerId)
      const modelLine = prefs.provider && prefs.model ? `${prefs.provider}/${prefs.model}` : '跟随 DSH 默认'
      const cwdLine = prefs.cwd ?? '跟随默认'
      const paused = node.outboxPausedUntil()
      const queueLine =
        paused !== null && paused > Date.now()
          ? `限流暂停中（约 ${Math.round((paused - Date.now()) / 1000)}s）`
          : `正常（队列 ${node.outbox.pendingCount()} 条）`
      const usage = tokenUsageSummary(session)
      const pairedId = await node.getPairedUserId()
      const allowFrom = node.resolved.allowFrom
      const trustLine =
        pairedId !== null
          ? `配对账号: ${pairedId}${allowFrom.length > 0 ? '（allowFrom 已配置）' : '（扫码自动白名单）'}`
          : allowFrom.length > 0
            ? `白名单: ${allowFrom.length} 人（allowFrom 配置）`
            : '白名单: 未配对且未配置（无人可进）'
      await sendTextToPeer(
        node,
        peerId,
        `📊 状态\n会话: ${session.id}\nagent: ${agent?.status ?? 'idle'}\n事件: ${session.seq} 条 · 最近: ${reason}\n模型偏好: ${modelLine}\n工作区偏好: ${cwdLine}\n出站: ${queueLine}${usage ? `\n本轮 token: ${usage}` : ''}\n${trustLine}\n📷 发图通道: 后端受限（入站图片正常）`,
        { kind: 'system' },
      )
    },
  },
  {
    id: 'model',
    summary: '查看/切换模型（对 /new 生效）',
    usage: '/model | /model default | /model <provider>/<model>',
    detail: '不带参数列出供应商（回复编号进入模型列表）。/model default 恢复跟随 DSH 默认模型。显式写法例：/model deepseek/deepseek-chat。只影响之后 /new 创建的会话。',
    run: async (node, peerId, args) => {
      const llm = node.ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
      const prefs = node.state.getPrefs(peerId)
      const current =
        prefs.provider && prefs.model
          ? `当前: ${prefs.provider}/${prefs.model}`
          : '当前: 跟随 DSH 默认'
      const arg = (args[0] ?? '').trim()
      if (!arg) {
        if (!llm) {
          await sendTextToPeer(node, peerId, `❌ 本部署没有可列出的模型供应商。${current}\n可用 /model <provider>/<model> 直接指定。`, { kind: 'system' })
          return
        }
        const providers = llm.listProviders()
        if (providers.length === 0) {
          await sendTextToPeer(node, peerId, `❌ 没有已注册的模型供应商。${current}`, { kind: 'system' })
          return
        }
        node.registerMenu(
          peerId,
          'provider',
          providers.map((p) => ({ label: p.id, value: p.id })),
        )
        await sendTextToPeer(
          node,
          peerId,
          `🤖 选择供应商（回复编号，0 取消）：\n${providers.map((p, i) => `${i + 1}. ${p.id}`).join('\n')}\n\n${current}`,
          { kind: 'system' },
        )
        return
      }
      if (arg === 'default') {
        node.state.setPrefs(peerId, { provider: '', model: '' })
        await sendTextToPeer(node, peerId, '✅ 已恢复跟随 DSH 默认模型（对 /new 生效）', { kind: 'system' })
        return
      }
      const [provider, model] = arg.includes('/') ? arg.split('/', 2) : [arg, args[1] ?? '']
      if (!provider || !model) {
        await sendTextToPeer(node, peerId, `❌ 用法: /model <provider>/<model>（或 /model <provider> <model>）`, { kind: 'system' })
        return
      }
      node.state.setPrefs(peerId, { provider, model })
      await sendTextToPeer(node, peerId, `✅ 模型偏好已设为 ${provider}/${model}（对 /new 新建的会话生效）`, { kind: 'system' })
    },
  },
  {
    id: 'workspace',
    summary: '查看/切换工作区（对 /new 生效）',
    usage: '/workspace | /workspace default',
    detail: '不带参数列出已注册工作区（回复编号选择）。/workspace default 恢复默认工作目录。只影响之后 /new 创建的会话；出于安全只允许选择 DSH 已注册的工作区。',
    run: async (node, peerId, args) => {
      const registry = node.ctx.get('workspaceRegistry') as
        | { list(): Array<{ id: string; path: string; title: string }> }
        | undefined
      const prefs = node.state.getPrefs(peerId)
      const current = prefs.cwd ? `当前: ${prefs.cwd}` : '当前: 跟随默认'
      const arg = (args[0] ?? '').trim()
      if (!arg) {
        if (!registry) {
          await sendTextToPeer(node, peerId, `❌ 本部署没有工作区注册表。${current}`, { kind: 'system' })
          return
        }
        const workspaces = registry.list()
        if (workspaces.length === 0) {
          await sendTextToPeer(node, peerId, `📂 没有已注册的工作区。${current}`, { kind: 'system' })
          return
        }
        node.registerMenu(
          peerId,
          'workspace',
          workspaces.map((w) => ({ label: `${w.title}（${w.path}）`, value: w.path })),
        )
        await sendTextToPeer(
          node,
          peerId,
          `📂 选择工作区（回复编号，0 取消）：\n${workspaces.map((w, i) => `${i + 1}. ${w.title}\n   ${w.path}`).join('\n')}\n\n${current}`,
          { kind: 'system' },
        )
        return
      }
      if (arg === 'default') {
        node.state.setPrefs(peerId, { cwd: '' })
        await sendTextToPeer(node, peerId, '✅ 已恢复默认工作目录（对 /new 生效）', { kind: 'system' })
        return
      }
      await sendTextToPeer(node, peerId, `❌ 只支持从列表选择：直接回复 /workspace 查看。${current}`, { kind: 'system' })
    },
  },
  {
    id: 'retry',
    summary: '重试上一次任务',
    usage: '/retry',
    detail: '把你在当前会话发的最后一条任务重新提交一遍（常用于出错后重试）。',
    run: async (node, peerId) => {
      const agent = node.activeAgent(peerId)
      if (!agent) {
        await sendTextToPeer(node, peerId, '❌ 没有活动的会话', { kind: 'system' })
        return
      }
      const last = node.getUserText(peerId)
      if (!last) {
        await sendTextToPeer(node, peerId, '❌ 没有可重试的任务（直接发一条新任务即可）', { kind: 'system' })
        return
      }
      node.rememberUserText(peerId, last)
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: last }],
          source: { kind: 'user' },
        }),
      )
      await sendTextToPeer(node, peerId, '🔁 已重新提交上次任务', { kind: 'system' })
    },
  },
  {
    id: 'close',
    summary: '归档当前会话',
    usage: '/close',
    detail: '把当前会话从工作区归档（历史保留在存储里），并解除微信侧的绑定。',
    run: async (node, peerId) => {
      const session = node.activeSession(peerId)
      if (!session) {
        await sendTextToPeer(node, peerId, '❌ 没有活动的会话', { kind: 'system' })
        return
      }
      const agent = node.activeAgent(peerId)
      if (agent) agent.cancel({ kind: 'user' })
      const registry = node.ctx.get('workspaceRegistry') as { archiveSession(id: string): Promise<void> } | undefined
      try {
        if (registry) await registry.archiveSession(session.id)
        node.setActiveSession(peerId, null)
        await sendTextToPeer(node, peerId, `🗂 已归档会话 ${session.id}`, { kind: 'system' })
      } catch (err) {
        await sendTextToPeer(node, peerId, `❌ 归档失败: ${err instanceof Error ? err.message : String(err)}`, { kind: 'system' })
      }
    },
  },
  {
    id: 'help',
    summary: '本帮助（/help <命令> 看详情）',
    usage: '/help [命令]',
    detail: '列出全部命令。带命令名时显示该命令的用法与说明。',
    run: async (node, peerId, args) => {
      await sendTextToPeer(node, peerId, helpText(args[0]), { kind: 'system' })
    },
  },
  {
    id: 'yes',
    summary: '同意最近一次权限请求',
    usage: '/yes',
    detail: '同意你最近一次待确认的权限请求。没有待确认请求时，这条命令只会提示一下。',
    run: async (node, peerId) => {
      await sendTextToPeer(node, peerId, '🔐 当前没有待确认的权限请求', { kind: 'system' })
    },
  },
  {
    id: 'no',
    summary: '拒绝最近一次权限请求',
    usage: '/no',
    detail: '拒绝你最近一次待确认的权限请求。没有待确认请求时，这条命令只会提示一下。',
    run: async (node, peerId) => {
      await sendTextToPeer(node, peerId, '🔐 当前没有待确认的权限请求', { kind: 'system' })
    },
  },
]

function describeTurnEnd(reason: { kind: string }): string {
  switch (reason.kind) {
    case 'completed': return '✅ 完成'
    case 'error': return '❌ 出错'
    case 'aborted': return '⏹ 已停止'
    case 'blocked': return '⏸ 已阻塞'
    case 'max-tokens': return '⚠️ 输出截断'
    case 'interrupted': return '⚠️ 中断'
    default: return reason.kind
  }
}

/** Latest turn's token usage from assistant/message events, when reported. */
function tokenUsageSummary(session: Session): string {
  let last: { input?: number; output?: number; reasoning?: number } | null = null
  for (const event of session.events) {
    if (event.type === 'assistant/message' && event.data.usage) {
      const usage = event.data.usage as unknown as {
        inputTokens?: number
        outputTokens?: number
        reasoningTokens?: number
      }
      last = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens,
      }
    }
  }
  if (!last) return ''
  const input = typeof last.input === 'number' ? `${last.input}` : '?'
  const output = typeof last.output === 'number' ? `${last.output}` : '?'
  const reasoning = typeof last.reasoning === 'number' ? ` · 思考 ${last.reasoning}` : ''
  return `入 ${input} / 出 ${output}${reasoning}`
}

export function helpText(commandId?: string): string {
  if (commandId) {
    const spec = COMMANDS.find((c) => c.id === commandId)
    if (!spec) return `❓ 没有命令 /${commandId}。回复 /help 查看全部。`
    return `🤖 /${spec.id}\n用法: ${spec.usage}\n\n${spec.detail}`
  }
  // Categorized overview — one short line per command, grouped for scanning
  // on a phone screen (each group ≤ 5 lines).
  const groups: Array<[string, string[]]> = [
    ['会话', ['modes', 'new', 'sessions', 'use', 'retry', 'close']],
    ['模型/工作区', ['model', 'workspace']],
    ['审批', ['yes', 'no']],
    ['其他', ['status', 'stop', 'thinking', 'export', 'card', 'help']],
  ]
  const sections = groups
    .map(([title, ids]) => {
      const lines = COMMANDS.filter((c) => ids.includes(c.id)).map((c) => `/${c.id} — ${c.summary}`)
      return lines.length > 0 ? `▍${title}\n${lines.join('\n')}` : ''
    })
    .filter(Boolean)
  return `🤖 dsh-wechat-bridge 命令\n${sections.join('\n')}\n\n/help <命令> 查看详情`
}

/** New P1/P2 commands appended to the registry (defined after the core list). */
COMMANDS.push(
  {
    id: 'thinking',
    summary: '思考内容开关（on=心跳附带思考原文）',
    usage: '/thinking on|off',
    detail: '开启后，思考心跳会附带最近 60 字的思考原文（默认只显示字数）。按 peer 持久化。',
    run: async (node, peerId, args) => {
      const arg = (args[0] ?? '').trim().toLowerCase()
      if (arg === 'on') {
        node.state.setPrefs(peerId, { thinking: true })
        await sendTextToPeer(node, peerId, '✅ 已开启思考原文（心跳将附带最近思考片段）', { kind: 'system' })
      } else if (arg === 'off') {
        node.state.setPrefs(peerId, { thinking: false })
        await sendTextToPeer(node, peerId, '✅ 已关闭思考原文（心跳只显示字数）', { kind: 'system' })
      } else {
        await sendTextToPeer(node, peerId, `当前: ${node.state.getPrefs(peerId).thinking ? '开启' : '关闭'}。用法: /thinking on|off`, { kind: 'system' })
      }
    },
  },
  {
    id: 'export',
    summary: '导出当前会话全文（.md 附件）',
    usage: '/export',
    detail: '把当前会话的完整对话记录导出为 Markdown 文件附件，可在微信里预览、转发或收藏。',
    run: async (node, peerId) => {
      const session = node.activeSession(peerId)
      if (!session) {
        await sendTextToPeer(node, peerId, '❌ 没有活动的会话', { kind: 'system' })
        return
      }
      const content = buildTranscript(session)
      const { filePath, fileName } = writeExportFile(node, session.id, content, 'transcript')
      await sendTextToPeer(node, peerId, `📎 会话全文已导出：${fileName}`, { kind: 'system' })
      node.enqueueMedia(peerId, 'file', filePath, fileName)
    },
  },
  {
    id: 'card',
    summary: '把最近一条回复渲染成长图',
    usage: '/card',
    detail: '把当前会话最近一条助手回复渲染成图片发送（长图模式，需 cardMode=long 且本机有 Chrome）。',
    run: async (node, peerId) => {
      if (node.resolved.cardMode !== 'long') {
        await sendTextToPeer(node, peerId, '🖼 长图模式未开启（cardMode: off）。配置 cardMode: long 后可用。', { kind: 'system' })
        return
      }
      const session = node.activeSession(peerId)
      if (!session) {
        await sendTextToPeer(node, peerId, '❌ 没有活动的会话', { kind: 'system' })
        return
      }
      const last = [...session.events].reverse().find((e) => e.type === 'assistant/message')
      if (!last || last.type !== 'assistant/message') {
        await sendTextToPeer(node, peerId, '❌ 没有可渲染的回复', { kind: 'system' })
        return
      }
      const text = textOfAssistantMessage(last.data.message)
      if (!text.trim()) {
        await sendTextToPeer(node, peerId, '❌ 最近一条回复没有文本内容', { kind: 'system' })
        return
      }
      await sendTextToPeer(node, peerId, '🖼 正在渲染长图…', { kind: 'system' })
      try {
        const { filePath } = await renderCardToPng(exportsDir(node), `card-${Date.now().toString(36)}`, text, node.resolved.chromePath)
        node.enqueueMedia(peerId, 'image', filePath, filePath.split('/').pop() ?? 'card.png')
      } catch (err) {
        await sendTextToPeer(node, peerId, `❌ 长图渲染失败: ${err instanceof Error ? err.message : String(err)}`, { kind: 'system' })
      }
    },
  },
)

// ---------------------------------------------------------------- routing

export type RouteResult = 'handled' | 'forward' | 'not-command'

/** Try to route one command. `forward` means: hand the unescaped text to the agent. */
export async function routeCommand(
  node: WechatBridgeNode,
  peerId: string,
  text: string,
): Promise<RouteResult> {
  const trimmed = text.trim()
  if (trimmed.startsWith('//')) return 'forward'
  if (!trimmed.startsWith('/')) return 'not-command'

  const [command, ...rest] = trimmed.slice(1).split(/\s+/)
  const spec = COMMANDS.find((c) => c.id === command)
  if (!spec) {
    await sendTextToPeer(
      node,
      peerId,
      `❓ 未知命令 /${command}\n${helpText()}\n\n提示：以 // 开头可把 / 开头的内容原样发给 agent。`,
      { kind: 'system' },
    )
    return 'handled'
  }
  await spec.run(node, peerId, rest)
  return 'handled'
}
