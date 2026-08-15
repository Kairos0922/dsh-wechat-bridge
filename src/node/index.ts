/**
 * wechat-bridge-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * M0 skeleton: config + allowlist shell. M2 adds the allowlist gate, the
 * dynamic agent-preset registry (`/modes`, `/new <mode>`), session commands,
 * approvals and digest outbound. M3 adds image-in-session.
 *
 * Consumes the `wechat` gateway service and dsh-base services
 * (`sessions`, `agents`, `approval`, `credentials`).
 *
 * @module dsh-wechat-bridge/node
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_MESSAGE_CHARS } from '../gateway/types.ts'

export interface NodeConfig {
  allowFrom?: string[]
  digestIntervalSec?: number
  approvalTimeoutSec?: number
  maxMessageChars?: number
  sendChunkDelayMs?: number
  cwd?: string
  defaultMode?: string
  agentProvider?: string
  agentModel?: string
}

export const NodeConfig = z.object({
  allowFrom: z.array(z.string()).default([]),
  digestIntervalSec: z.number().default(300),
  approvalTimeoutSec: z.number().default(600),
  maxMessageChars: z.number().default(MAX_MESSAGE_CHARS),
  sendChunkDelayMs: z.number().default(1_500),
  cwd: z.string(),
  defaultMode: z.string(),
  agentProvider: z.string(),
  agentModel: z.string(),
})

export function wechatBridgeNode(ctx: Context, config: NodeConfig): void {
  ctx.effect(() => {
    ctx.logger.info(
      '[dsh-wechat-bridge] wechat-bridge-node mounted (allowFrom=%d, defaultMode=%s)',
      config.allowFrom?.length ?? 0,
      config.defaultMode || '(unset)',
    )
    return () => ctx.logger.info('[dsh-wechat-bridge] wechat-bridge-node disposed')
  })
}

export default wechatBridgeNode
