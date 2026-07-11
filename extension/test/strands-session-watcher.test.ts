/**
 * Unit tests for StrandsSessionWatcher.
 *
 * Writes a sample JSONL fixture to a temp directory, starts the watcher
 * pointing at it, and verifies the emitted events match expectations.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'os'
import { StrandsSessionWatcher } from '../src/strands-session-watcher'
import type { AgentEvent } from '../src/protocol'

const FIXTURE = path.join(__dirname, 'fixtures', 'strands-session-sample.jsonl')

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strands-test-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function copyFixtureToTemp(sessionId: string): string {
  const dest = path.join(tempDir, `${sessionId}.jsonl`)
  fs.copyFileSync(FIXTURE, dest)
  return dest
}

describe('StrandsSessionWatcher', () => {
  it('discovers and parses a JSONL session file', async () => {
    const sessionId = 'test-strands-session'
    copyFixtureToTemp(sessionId)

    // Point watcher at our temp dir via STRANDS_HOME
    process.env.STRANDS_HOME = path.dirname(tempDir)
    // Rename tempDir to "agent-flow" since that's what the watcher expects
    const agentFlowDir = path.join(path.dirname(tempDir), 'agent-flow')
    fs.renameSync(tempDir, agentFlowDir)
    tempDir = agentFlowDir // so afterEach cleans it up

    const events: AgentEvent[] = []
    const watcher = new StrandsSessionWatcher(null)
    watcher.onEvent((e) => events.push(e))

    watcher.start()

    // Give the watcher time to scan and read
    await new Promise(resolve => setTimeout(resolve, 200))

    watcher.dispose()
    delete process.env.STRANDS_HOME

    // Verify events were emitted
    assert.ok(events.length >= 8, `Expected at least 8 events, got ${events.length}`)

    // First event should be agent_spawn
    assert.equal(events[0].type, 'agent_spawn')
    assert.equal(events[0].payload.name, 'orchestrator')
    assert.equal(events[0].payload.runtime, 'strands')
    assert.equal(events[0].payload.isMain, true)

    // Should have tool_call_start events
    const toolStarts = events.filter(e => e.type === 'tool_call_start')
    assert.equal(toolStarts.length, 2)
    assert.equal(toolStarts[0].payload.tool, 'list_files')
    assert.equal(toolStarts[1].payload.tool, 'read_file')

    // Should have tool_call_end events
    const toolEnds = events.filter(e => e.type === 'tool_call_end')
    assert.equal(toolEnds.length, 2)

    // Should have context_update
    const ctxUpdates = events.filter(e => e.type === 'context_update')
    assert.ok(ctxUpdates.length >= 1)
    assert.equal(ctxUpdates[0].payload.tokens, 15000)

    // Should have agent_complete
    const completes = events.filter(e => e.type === 'agent_complete')
    assert.ok(completes.length >= 1)

    // All events should have the sessionId attached
    for (const e of events) {
      assert.equal(e.sessionId, sessionId)
    }
  })

  it('reports session lifecycle events', async () => {
    const sessionId = 'test-strands-session'
    copyFixtureToTemp(sessionId)

    process.env.STRANDS_HOME = path.dirname(tempDir)
    const agentFlowDir = path.join(path.dirname(tempDir), 'agent-flow')
    if (fs.existsSync(agentFlowDir)) fs.rmSync(agentFlowDir, { recursive: true })
    fs.renameSync(tempDir, agentFlowDir)
    tempDir = agentFlowDir

    const detected: string[] = []
    const watcher = new StrandsSessionWatcher(null)
    watcher.onSessionDetected((id) => detected.push(id))

    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 200))

    watcher.dispose()
    delete process.env.STRANDS_HOME

    assert.ok(detected.includes(sessionId), 'Session should be detected')
    assert.ok(watcher.getActiveSessions().length === 0, 'After dispose, no active sessions')
  })

  it('filters by workspace cwd from first agent_spawn', async () => {
    const sessionId = 'test-strands-session'
    copyFixtureToTemp(sessionId)

    process.env.STRANDS_HOME = path.dirname(tempDir)
    const agentFlowDir = path.join(path.dirname(tempDir), 'agent-flow')
    if (fs.existsSync(agentFlowDir)) fs.rmSync(agentFlowDir, { recursive: true })
    fs.renameSync(tempDir, agentFlowDir)
    tempDir = agentFlowDir

    const events: AgentEvent[] = []
    // Use a workspace that does NOT match the fixture's cwd (/tmp/test-workspace)
    const watcher = new StrandsSessionWatcher('/nonexistent/workspace')
    watcher.onEvent((e) => events.push(e))

    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 200))

    watcher.dispose()
    delete process.env.STRANDS_HOME

    // Session should be filtered out — no events emitted
    assert.equal(events.length, 0, 'Session with non-matching cwd should be filtered')
  })

  it('skips empty and malformed lines gracefully', async () => {
    process.env.STRANDS_HOME = path.dirname(tempDir)
    const agentFlowDir = path.join(path.dirname(tempDir), 'agent-flow')
    if (fs.existsSync(agentFlowDir)) fs.rmSync(agentFlowDir, { recursive: true })
    fs.renameSync(tempDir, agentFlowDir)
    tempDir = agentFlowDir

    const sessionId = 'malformed-test'
    const dest = path.join(agentFlowDir, `${sessionId}.jsonl`)
    fs.writeFileSync(dest, [
      '',
      'not json at all',
      '{"no_type_field": true}',
      '{"type": "agent_spawn", "time": 0, "payload": {"name": "orchestrator", "isMain": true, "runtime": "strands"}}',
      '{"type": "agent_complete", "time": 1, "payload": {"name": "orchestrator"}}',
    ].join('\n') + '\n')

    const events: AgentEvent[] = []
    const watcher = new StrandsSessionWatcher(null)
    watcher.onEvent((e) => events.push(e))

    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 200))

    watcher.dispose()
    delete process.env.STRANDS_HOME

    // Only valid lines should produce events
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'agent_spawn')
    assert.equal(events[1].type, 'agent_complete')
  })
})
