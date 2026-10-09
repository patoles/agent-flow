import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { shouldCommitFrame, UI_THROTTLE_MS } from './ui-throttle'

const base = { now: 10_000, lastCommitAt: 9_000, processedEvents: false, currentTime: 12.4, lastCommittedTime: 12.1 }

test('commits when events were processed', () => {
  assert.equal(shouldCommitFrame({ ...base, processedEvents: true }), true)
})

test('commits when the clock crosses a whole second without events (#90)', () => {
  assert.equal(shouldCommitFrame({ ...base, currentTime: 13.02 }), true)
})

test('skips frames where nothing visible changed', () => {
  assert.equal(shouldCommitFrame(base), false)
})

test('throttles to UI_THROTTLE_MS', () => {
  const recent = { ...base, lastCommitAt: base.now - UI_THROTTLE_MS + 1 }
  assert.equal(shouldCommitFrame({ ...recent, processedEvents: true }), false)
  assert.equal(shouldCommitFrame({ ...recent, currentTime: 20 }), false)
})

test('commits on the first frame', () => {
  assert.equal(shouldCommitFrame({ ...base, lastCommitAt: 0, processedEvents: true }), true)
})
