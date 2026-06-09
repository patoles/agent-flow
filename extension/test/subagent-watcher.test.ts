/**
 * Unit tests for subagent transcript discovery.
 *
 * Regression coverage for Workflow subagents: newer Claude Code writes their
 * transcripts under `subagents/workflows/wf_<id>/agent-*.jsonl` (two levels
 * below the session's `subagents/` dir). The old flat readdir scan missed them,
 * so Workflow-spawned subagents never appeared in the visualizer. The scanner
 * must now recurse and pick up transcripts at any depth.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectSubagentJsonlFiles } from '../src/subagent-watcher'

describe('collectSubagentJsonlFiles', () => {
  let root: string

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-subagents-'))
    // Flat subagent (Task/fork) — already worked before the fix.
    fs.writeFileSync(path.join(root, 'agent-flat.jsonl'), '')
    fs.writeFileSync(path.join(root, 'agent-flat.meta.json'), '{}')
    // Nested Workflow subagents — previously missed by the flat scan.
    const wfDir = path.join(root, 'workflows', 'wf_f76aef6d-59e')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, 'agent-a0fb14872db487d5b.jsonl'), '')
    fs.writeFileSync(path.join(wfDir, 'agent-a134085130eaecaf1.jsonl'), '')
    // Sidecar/non-jsonl files must be ignored.
    fs.writeFileSync(path.join(wfDir, 'agent-a0fb14872db487d5b.meta.json'), '{}')
  })

  after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('finds both flat and deeply nested *.jsonl transcripts', () => {
    const found = collectSubagentJsonlFiles(root).sort()
    assert.deepEqual(found.map(f => path.relative(root, f).split(path.sep).join('/')).sort(), [
      'agent-flat.jsonl',
      'workflows/wf_f76aef6d-59e/agent-a0fb14872db487d5b.jsonl',
      'workflows/wf_f76aef6d-59e/agent-a134085130eaecaf1.jsonl',
    ])
  })

  it('ignores .meta.json sidecars and other non-jsonl files', () => {
    const found = collectSubagentJsonlFiles(root)
    assert.ok(found.every(f => f.endsWith('.jsonl')))
    assert.ok(!found.some(f => f.endsWith('.meta.json')))
  })

  it('returns an empty array for a missing directory instead of throwing', () => {
    assert.deepEqual(collectSubagentJsonlFiles(path.join(root, 'does-not-exist')), [])
  })
})
