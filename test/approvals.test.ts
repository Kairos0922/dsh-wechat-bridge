/**
 * Approval-bridge unit tests — argument summary recovery from session logs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { approvalArgsSummary } from '../src/node/approvals.ts'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

function fakeRequest(callId: string | undefined, events: unknown[]): ApprovalRequest {
  return {
    toolName: 'bash',
    callId,
    reason: 'needs consent',
    agent: { session: { events } },
  } as unknown as ApprovalRequest
}

test('approvalArgsSummary recovers collapsed arguments from the logged tool call', () => {
  const request = fakeRequest('call-1', [
    { type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: '{\n  "cmd": "ls -la"\n}' } },
  ])
  assert.equal(approvalArgsSummary(request), '{ "cmd": "ls -la" }')
})

test('approvalArgsSummary truncates very long arguments', () => {
  const request = fakeRequest('call-1', [
    { type: 'tool/call', data: { callId: 'call-1', name: 'fs', arguments: 'x'.repeat(500) } },
  ])
  const summary = approvalArgsSummary(request)!
  assert.ok(summary.length <= 161)
  assert.ok(summary.endsWith('…'))
})

test('approvalArgsSummary returns null without a callId or matching event', () => {
  assert.equal(approvalArgsSummary(fakeRequest(undefined, [])), null)
  const request = fakeRequest('call-1', [
    { type: 'tool/call', data: { callId: 'call-2', name: 'bash', arguments: '{}' } },
  ])
  assert.equal(approvalArgsSummary(request), null)
})
