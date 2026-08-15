/**
 * PresetRegistry unit tests — fixture dirs, no live DSH needed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PresetRegistry, discoverPresets } from '../src/node/presets.ts'

function makeFixture(entries: Array<[string, boolean]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-presets-'))
  for (const [id, withManifest] of entries) {
    const presetDir = path.join(dir, id)
    fs.mkdirSync(presetDir)
    if (withManifest) fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), 'agent: true\n')
  }
  return dir
}

test('discoverPresets lists only dirs with agent.cordis.yml, sorted', () => {
  const dir = makeFixture([
    ['life-butler', true],
    ['life-finance', true],
    ['junk-dir', false],
  ])
  const presets = discoverPresets(dir)
  assert.deepEqual(
    presets.map((p) => p.id),
    ['life-butler', 'life-finance'],
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('discoverPresets returns [] for a missing dir', () => {
  assert.deepEqual(discoverPresets('/nonexistent/definitely-missing'), [])
})

test('resolveMode prefers explicit, falls back to default, rejects unknown', () => {
  // Build a fake DSH_HOME with .agent-presets inside it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-home-'))
  const presetsDir = path.join(home, '.agent-presets')
  for (const id of ['life-butler', 'life-career']) {
    const dir = path.join(presetsDir, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), 'agent: true\n')
  }
  const origHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const registry = new PresetRegistry()
  try {
    assert.equal(registry.resolveMode('life-career', 'life-butler'), 'life-career')
    assert.equal(registry.resolveMode(undefined, 'life-butler'), 'life-butler')
    assert.equal(registry.resolveMode('unknown-mode', 'life-butler'), 'life-butler')
    assert.equal(registry.resolveMode(undefined, undefined), undefined)
  } finally {
    if (origHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
