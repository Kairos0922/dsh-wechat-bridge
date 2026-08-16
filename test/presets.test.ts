/**
 * Mode discovery unit tests — fake `agentPresets` service, no live DSH needed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { listModes, resolveMode } from '../src/node/presets.ts'

function fakeCtx(presets: Array<{ id: string; name?: string; description?: string; order?: number; broken?: string }>) {
  return {
    agentPresets: { list: async () => presets },
  } as never
}

test('listModes returns metadata-annotated presets in order', async () => {
  const modes = await listModes(
    fakeCtx([
      { id: 'z-last', name: 'Z', order: 2 },
      { id: 'a-first', name: 'A 模式', description: '第一个', order: 1 },
    ]),
  )
  assert.deepEqual(
    modes.map((m) => m.id),
    ['a-first', 'z-last'],
  )
  assert.equal(modes[0]!.name, 'A 模式')
  assert.equal(modes[0]!.description, '第一个')
})

test('listModes skips broken presets', async () => {
  const modes = await listModes(
    fakeCtx([
      { id: 'good' },
      { id: 'broken', broken: 'bad yaml' },
    ]),
  )
  assert.deepEqual(
    modes.map((m) => m.id),
    ['good'],
  )
})

test('listModes degrades to empty when the service throws', async () => {
  const ctx = {
    agentPresets: {
      list: async () => {
        throw new Error('no service')
      },
    },
  } as never
  assert.deepEqual(await listModes(ctx), [])
})

test('resolveMode prefers an explicit known mode', async () => {
  const ctx = fakeCtx([{ id: 'life-finance' }])
  assert.equal(await resolveMode(ctx, 'life-finance', 'life-butler'), 'life-finance')
})

test('resolveMode rejects unknown explicit modes and falls back to the default', async () => {
  const ctx = fakeCtx([{ id: 'life-butler' }])
  assert.equal(await resolveMode(ctx, 'nope', 'life-butler'), 'life-butler')
})

test('resolveMode returns undefined when neither matches', async () => {
  const ctx = fakeCtx([])
  assert.equal(await resolveMode(ctx, 'nope', 'also-nope'), undefined)
})
