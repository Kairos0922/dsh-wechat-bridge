/**
 * /video path-validation table (C1 fix): extension, regular-file, size cap,
 * realpath containment under the configured roots, and the ftyp magic check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateVideoPath, VIDEO_MAX_BYTES } from '../src/node/commands.ts'

/** Minimal valid MP4 header: size(4) + "ftyp" + brand bytes. */
const MP4_HEADER = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)])

function fakeNode(overrides: { videoRoots?: string[]; cwd?: string; mediaDir?: string } = {}): never {
  return {
    resolved: {
      cwd: overrides.cwd,
      mediaDir: overrides.mediaDir,
      videoRoots: overrides.videoRoots,
    },
  } as never
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-video-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeFile(dir: string, name: string, content: Buffer): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

test('a valid .mp4 inside the configured root passes', () =>
  withTmpDir((dir) => {
    const file = writeFile(dir, 'clip.mp4', MP4_HEADER)
    assert.equal(validateVideoPath(fakeNode({ videoRoots: [dir] }), file), null)
  }))

test('default roots include the cwd and the media dir', () =>
  withTmpDir((cwd) =>
    withTmpDir((media) => {
      const file = writeFile(cwd, 'a.mp4', MP4_HEADER)
      assert.equal(validateVideoPath(fakeNode({ cwd, mediaDir: media }), file), null)
      const file2 = writeFile(media, 'b.mp4', MP4_HEADER)
      assert.equal(validateVideoPath(fakeNode({ cwd, mediaDir: media }), file2), null)
    }),
  ))

test('rejects files outside every root — the arbitrary-read hole is closed', () =>
  withTmpDir((allowed) =>
    withTmpDir((elsewhere) => {
      const secret = writeFile(elsewhere, 'secret.mp4', MP4_HEADER)
      const reason = validateVideoPath(fakeNode({ videoRoots: [allowed] }), secret)
      assert.ok(reason !== null && reason.includes('工作区'), 'outside-root path refused')
      // And a classic traversal /etc path never gets near the file channel.
      assert.ok(validateVideoPath(fakeNode({ videoRoots: [allowed] }), '/etc/hosts') !== null)
    }),
  ))

test('rejects non-.mp4 extensions even inside the root', () =>
  withTmpDir((dir) => {
    const pem = writeFile(dir, 'id_rsa.mp4.txt', MP4_HEADER)
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), pem) !== null)
    const noExt = writeFile(dir, 'clip', MP4_HEADER)
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), noExt) !== null)
    const upper = writeFile(dir, 'clip.MP4', MP4_HEADER)
    assert.equal(validateVideoPath(fakeNode({ videoRoots: [dir] }), upper), null, 'case-insensitive extension')
  }))

test('rejects directories', () =>
  withTmpDir((dir) => {
    const subdir = path.join(dir, 'looks.mp4')
    fs.mkdirSync(subdir)
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), subdir) !== null)
  }))

test('rejects oversized files before any upload begins', () =>
  withTmpDir((dir) => {
    const big = path.join(dir, 'big.mp4')
    fs.writeFileSync(big, MP4_HEADER)
    fs.truncateSync(big, VIDEO_MAX_BYTES + 1)
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), big)?.includes('10MB'))
  }))

test('rejects renamed non-videos via the ftyp magic check', () =>
  withTmpDir((dir) => {
    const fake = writeFile(dir, 'fake.mp4', Buffer.from('#!/bin/sh\necho pwned\n'))
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), fake) !== null)
  }))

test('a symlink escaping the root is refused (realpath containment)', () =>
  withTmpDir((allowed) =>
    withTmpDir((outside) => {
      const target = writeFile(outside, 'real.mp4', MP4_HEADER)
      const link = path.join(allowed, 'link.mp4')
      fs.symlinkSync(target, link)
      assert.ok(validateVideoPath(fakeNode({ videoRoots: [allowed] }), link) !== null, 'symlink resolves outside the root')
    }),
  ))

test('missing files report as not-found', () =>
  withTmpDir((dir) => {
    assert.ok(validateVideoPath(fakeNode({ videoRoots: [dir] }), path.join(dir, 'nope.mp4'))?.includes('不存在'))
  }))
