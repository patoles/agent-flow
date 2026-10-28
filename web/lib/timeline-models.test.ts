import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { TimelineEntry } from './agent-types'
import { withTimelineModel, formatTimelineModels } from './timeline-models'

const entry: TimelineEntry = { id: 'timeline-a', agentId: 'a', agentName: 'a', startTime: 0, blocks: [] }

test('records models in first-seen order', () => {
  let e = withTimelineModel(entry, 'claude-opus-5-5')
  e = withTimelineModel(e, 'claude-fable-5-1')
  e = withTimelineModel(e, 'claude-opus-5-5')
  assert.deepEqual(e.models, ['claude-opus-5-5', 'claude-fable-5-1'])
})

test('returns the same entry when nothing changes', () => {
  const e = withTimelineModel(entry, 'claude-opus-5-5')
  assert.equal(withTimelineModel(e, 'claude-opus-5-5'), e)
  assert.equal(withTimelineModel(e, ''), e)
  assert.equal(entry.models, undefined)
})

test('formats models for display, merging variants with the same name', () => {
  assert.equal(formatTimelineModels(undefined), '')
  assert.equal(formatTimelineModels(['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1']), 'Opus 5.5 → Fable 5.1')
})
