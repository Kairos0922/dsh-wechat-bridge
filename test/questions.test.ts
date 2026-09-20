/**
 * User-question bridge tests.
 *
 * Covers the two halves of the 2026-09-20 incident fix: reply parsing (a phone
 * reply must become a structured DSH answer) and the answerer's claim/delegate
 * decision (a WeChat-owned session must be claimed BEFORE the browser forwarder
 * parks the request where the phone cannot see it).
 *
 * The node is constructed with a fake ctx — no DSH services, no network. The
 * HOME is redirected so no test can touch live bridge state.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SessionId } from '@deepseek-ai/dsh-session'
import { WechatBridgeNode } from '../src/node/core.ts'
import {
  attachUserQuestionBridge,
  buildQuestionPrompt,
  parseQuestionReply,
  type PendingQuestion,
} from '../src/node/questions.ts'

// Never let a test touch the live bridge state (~/.dsh/storages/…).
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wechat-bridge-questions-test-'))

const PEER = 'peer-a@im.wechat'
const SESSION = 'wechat-test0001-abc'

const CONFIG = {
  allowFrom: [PEER],
  approvalTimeoutSec: 600,
  questionTimeoutSec: 1800,
  maxMessageChars: 2000,
  // 0 so a test never waits out the real rate-limit spacing between sends.
  minSendIntervalMs: 0,
  rateLimitBackoffSecs: [10, 30, 60],
  sendBudgetWindowSec: 60,
  sendBudgetMaxPerWindow: 4,
  sessionExpiredPauseMin: 60,
  thinkingDigestSec: 10,
  menuTimeoutSec: 60,
  markdownMode: 'passthrough',
  progressToolPrefixes: [],
} as never

/** A fake ctx capturing `on` registrations and stubbing the send path. */
function fakeCtx() {
  const registrations: Array<{ name: string; listener: (...args: never[]) => unknown; options: unknown }> = []
  const sent: string[] = []
  const ctx = {
    registrations,
    sent,
    on(name: string, listener: (...args: never[]) => unknown, options: unknown) {
      registrations.push({ name, listener, options })
      return () => {}
    },
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    wechat: {
      async sendText(args: { text: string }) {
        sent.push(args.text)
        return { ok: true }
      },
    },
  }
  return ctx
}

function harness() {
  const ctx = fakeCtx()
  const node = new WechatBridgeNode(ctx as never, CONFIG)
  node.setActiveSession(PEER, SessionId(SESSION))
  const prompts: string[] = []
  const enqueue = node.enqueueQuestionPrompt.bind(node)
  node.enqueueQuestionPrompt = (peerId: string, text: string, number: number) => {
    prompts.push(text)
    enqueue(peerId, text, number)
  }
  attachUserQuestionBridge(node)
  const registration = ctx.registrations.find((entry) => entry.name === 'user-questions/request')!
  const listener = registration.listener as unknown as (
    request: unknown,
    next: () => Promise<unknown>,
  ) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
  return { ctx, node, prompts, listener, options: registration.options }
}

const TWO_OPTIONS = {
  id: 'confirm_create',
  question: '创建私有仓库与红线 1 冲突，如何处理？',
  options: [{ label: '只建不推' }, { label: '不创建了' }],
}

function request(questions: unknown[], agent: unknown = { session: { id: SESSION } }) {
  return { questions, agent }
}

// ---------------------------------------------------------------- parsing

test('a numbered reply selects the option by position', () => {
  assert.deepEqual(parseQuestionReply('2', TWO_OPTIONS), { kind: 'answer', selected: ['不创建了'] })
  assert.deepEqual(parseQuestionReply(' 1 ', TWO_OPTIONS), { kind: 'answer', selected: ['只建不推'] })
})

test('a multi-select question accepts several numbers in one reply', () => {
  const multi = { id: 'm', question: '选哪些？', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }
  assert.deepEqual(parseQuestionReply('1,3', multi), { kind: 'answer', selected: ['A', 'C'] })
  assert.deepEqual(parseQuestionReply('1 2', multi), { kind: 'answer', selected: ['A', 'B'] })
  // Duplicates collapse instead of answering the same option twice.
  assert.deepEqual(parseQuestionReply('2,2', multi), { kind: 'answer', selected: ['B'] })
})

test('a single-select question rejects several numbers instead of guessing', () => {
  const reply = parseQuestionReply('1 2', TWO_OPTIONS)
  assert.equal(reply.kind, 'invalid')
})

test('an out-of-range number is reported, not treated as custom text', () => {
  assert.equal(parseQuestionReply('7', TWO_OPTIONS).kind, 'invalid')
  assert.equal(parseQuestionReply('0', TWO_OPTIONS).kind, 'invalid')
})

test('free text becomes the custom answer DSH already understands', () => {
  assert.deepEqual(parseQuestionReply('先把红线改了再说', TWO_OPTIONS), {
    kind: 'answer',
    selected: [],
    custom: '先把红线改了再说',
  })
  const freeform = { id: 'f', question: '仓库叫什么？' }
  assert.deepEqual(parseQuestionReply('kairos-personal-os', freeform), {
    kind: 'answer',
    selected: [],
    custom: 'kairos-personal-os',
  })
})

test('a slash command is never swallowed as an answer (/stop stays reachable)', () => {
  assert.deepEqual(parseQuestionReply('/stop', TWO_OPTIONS), { kind: 'none' })
  assert.deepEqual(parseQuestionReply('/status', { id: 'f', question: 'x' }), { kind: 'none' })
  assert.deepEqual(parseQuestionReply('   ', TWO_OPTIONS), { kind: 'none' })
})

// ---------------------------------------------------------------- prompt

test('the prompt numbers the options and carries the question', () => {
  const pending = {
    number: 3,
    peerId: PEER,
    request: request([TWO_OPTIONS]),
    index: 0,
  } as unknown as PendingQuestion
  const prompt = buildQuestionPrompt(pending, 1800)
  assert.match(prompt, /#3/)
  assert.match(prompt, /创建私有仓库与红线 1 冲突/)
  assert.match(prompt, /1\. 只建不推/)
  assert.match(prompt, /2\. 不创建了/)
  assert.match(prompt, /30 分钟/)
})

test('a multi-question request shows its position and truncates long detail', () => {
  const detail = 'x'.repeat(900)
  const pending = {
    number: 1,
    peerId: PEER,
    request: request([
      { id: 'a', question: '第一问' },
      { id: 'b', question: '第二问', detail },
    ]),
    index: 1,
  } as unknown as PendingQuestion
  const prompt = buildQuestionPrompt(pending, 60)
  assert.match(prompt, /第 2\/2 问/)
  assert.match(prompt, /第二问/)
  assert.match(prompt, /已截断/)
  assert.ok(!prompt.includes(detail), 'the raw over-long detail must not be sent whole')
})

// ---------------------------------------------------------------- answerer

test('the answerer claims with prepend so it beats the browser forwarder', () => {
  const { node, options, listener } = harness()
  assert.deepEqual(options, { prepend: true })
  assert.equal(typeof listener, 'function')
  node.dispose()
})

test('a question for a WeChat-owned session is answered from the phone', async () => {
  const { node, prompts, listener } = harness()
  const pending = listener(request([TWO_OPTIONS]), async () => {
    throw new Error('must not delegate')
  })
  assert.ok(node.hasPendingQuestion(PEER), 'the request must be pending')
  assert.equal(prompts.length, 1, 'the question must be visible before the user can answer')
  assert.match(prompts[0]!, /创建私有仓库与红线 1 冲突/)

  assert.equal(node.resolveUserQuestion('1', PEER), true)
  assert.deepEqual(await pending, { answers: [{ id: 'confirm_create', selected: ['只建不推'] }] })
  assert.ok(!node.hasPendingQuestion(PEER), 'a settled question must deregister')
  node.dispose()
})

test('the answerer delegates when there is no WeChat owner', async () => {
  const { node, listener } = harness()
  let delegated = 0
  const next = async () => {
    delegated += 1
    return { answers: [] }
  }
  // No agent at all.
  await listener({ questions: [TWO_OPTIONS] }, next)
  // An agent whose session no peer owns.
  await listener(request([TWO_OPTIONS], { session: { id: 'someone-elses-session' } }), next)
  assert.equal(delegated, 2)
  assert.ok(!node.hasPendingQuestion(PEER))
  node.dispose()
})

test('a slash command falls through to normal routing while a question is pending', async () => {
  const { node, listener } = harness()
  const pending = listener(request([TWO_OPTIONS]), async () => ({ answers: [] }))
  assert.equal(node.resolveUserQuestion('/stop', PEER), false, '/stop must reach the command layer')
  assert.equal(node.resolveUserQuestion('看下任务进度啊', PEER), true, 'plain text is the custom answer')
  assert.deepEqual(await pending, {
    answers: [{ id: 'confirm_create', selected: [], custom: '看下任务进度啊' }],
  })
  node.dispose()
})

test('a malformed reply keeps the question open and explains why', async () => {
  const { node, listener } = harness()
  const pending = listener(request([TWO_OPTIONS]), async () => ({ answers: [] }))
  assert.equal(node.resolveUserQuestion('9', PEER), true, 'the invalid reply is consumed')
  assert.ok(node.hasPendingQuestion(PEER), 'the question must stay open')
  assert.equal(node.resolveUserQuestion('2', PEER), true)
  assert.deepEqual(await pending, { answers: [{ id: 'confirm_create', selected: ['不创建了'] }] })
  node.dispose()
})

test('multiple questions in one request are asked one at a time', async () => {
  const { node, prompts, listener } = harness()
  const pending = listener(
    request([
      { id: 'q1', question: '第一问', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '第二问', options: [{ label: 'C' }, { label: 'D' }] },
    ]),
    async () => ({ answers: [] }),
  )
  assert.match(prompts[0]!, /第 1\/2 问/)
  assert.equal(node.resolveUserQuestion('1', PEER), true)
  assert.equal(prompts.length, 2, 'the next question must be shown after the first answer')
  assert.match(prompts[1]!, /第 2\/2 问/)
  assert.equal(node.resolveUserQuestion('2', PEER), true)
  assert.deepEqual(await pending, {
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['D'] },
    ],
  })
  assert.ok(!node.hasPendingQuestion(PEER))
  node.dispose()
})

test('an aborted request deregisters so a later reply is not swallowed', async () => {
  const { node, listener } = harness()
  const controller = new AbortController()
  const pending = listener(
    { questions: [TWO_OPTIONS], agent: { session: { id: SESSION } }, signal: controller.signal },
    async () => ({ answers: [] }),
  )
  assert.ok(node.hasPendingQuestion(PEER))
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.ok(!node.hasPendingQuestion(PEER), 'an aborted request must not stay registered')
  assert.equal(node.resolveUserQuestion('1', PEER), false, 'nothing is pending any more')
  node.dispose()
})

test('an unanswered question times out instead of hanging the turn forever', async () => {
  const ctx = fakeCtx()
  const node = new WechatBridgeNode(ctx as never, { ...(CONFIG as object), questionTimeoutSec: 1 } as never)
  node.setActiveSession(PEER, SessionId(SESSION))
  attachUserQuestionBridge(node)
  const listener = ctx.registrations.find((entry) => entry.name === 'user-questions/request')!
    .listener as unknown as (request: unknown, next: () => Promise<unknown>) => Promise<unknown>

  const pending = listener(request([TWO_OPTIONS]), async () => ({ answers: [] }))
  await assert.rejects(pending, /未回答/)
  assert.ok(!node.hasPendingQuestion(PEER))
  // The notice travels the real outbox, so give the pump a tick to dispatch it.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(
    ctx.sent.some((text) => text.includes('超时未回答')),
    'the user must be told the question expired',
  )
  node.dispose()
})
