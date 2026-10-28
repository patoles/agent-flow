import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileCollisionIndex, touchAction } from '../extension/src/file-collisions'

test('read vs read on the same file is not a collision', () => {
  const idx = new FileCollisionIndex(90_000)
  assert.equal(idx.touch('/p/a.ts', { sessionId: 's1', agent: 'orchestrator', action: 'read', wall: 1000 }), null)
  assert.equal(idx.touch('/p/a.ts', { sessionId: 's2', agent: 'orchestrator', action: 'read', wall: 2000 }), null)
})

test('write after another party read inside the window is a collision with both parties', () => {
  const idx = new FileCollisionIndex(90_000)
  idx.touch('/p/a.ts', { sessionId: 's1', agent: 'orchestrator', action: 'read', wall: 1000 })
  const c = idx.touch('/p/a.ts', { sessionId: 's2', agent: 'orchestrator', action: 'write', wall: 5000 })
  assert.ok(c)
  assert.equal(c.parties.length, 2)
  assert.deepEqual([...new Set(c.parties.map(p => p.sessionId))].sort(), ['s1', 's2'])
})

test('same session, two subagents, one writes: collision', () => {
  const idx = new FileCollisionIndex(90_000)
  idx.touch('/p/a.ts', { sessionId: 's1', agent: 'find:clock', action: 'write', wall: 1000 })
  const c = idx.touch('/p/a.ts', { sessionId: 's1', agent: 'find:relay', action: 'read', wall: 1500 })
  assert.ok(c)
  assert.deepEqual(c.parties.map(p => p.agent).sort(), ['find:clock', 'find:relay'])
})

test('same party touching twice is not a collision, and touches outside the window expire', () => {
  const idx = new FileCollisionIndex(90_000)
  idx.touch('/p/a.ts', { sessionId: 's1', agent: 'orchestrator', action: 'write', wall: 1000 })
  assert.equal(idx.touch('/p/a.ts', { sessionId: 's1', agent: 'orchestrator', action: 'write', wall: 2000 }), null)
  // s2 arrives 5 minutes later: s1's touch is stale
  assert.equal(idx.touch('/p/a.ts', { sessionId: 's2', agent: 'orchestrator', action: 'write', wall: 2000 + 300_000 }), null)
})

test('touchAction classifies editing tools as writes', () => {
  assert.equal(touchAction('Edit'), 'write')
  assert.equal(touchAction('Write'), 'write')
  assert.equal(touchAction('Read'), 'read')
  assert.equal(touchAction('Grep'), 'read')
})
