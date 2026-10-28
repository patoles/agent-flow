/**
 * Unit tests for Workflow subagent completion.
 *
 * Workflow-spawned subagents are file-tailed (their transcripts live under
 * subagents/workflows/wf_<id>/) but never spawn via the Task/Agent tools, so
 * the tool_result-driven agent_complete path never fires for them. Instead,
 * when the parent's Workflow tool_result arrives, the parser completes every
 * workflow-path subagent that is idle (no unmatched pending tool calls) —
 * agents of a still-running concurrent Workflow are mid-tool and left alone.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { TranscriptParser } from '../src/transcript-parser'
import { AgentEvent, SubagentState, WatchedSession } from '../src/protocol'

const SESSION_ID = 'sess-1'

function makeSubagentState(agentName: string, overrides: Partial<SubagentState> = {}): SubagentState {
  return {
    watcher: null,
    fileSize: 0,
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: true,
    completed: false,
    ...overrides,
  }
}

function makeSession(): WatchedSession {
  return {
    sessionId: SESSION_ID,
    filePath: path.join(path.sep, 'proj', `${SESSION_ID}.jsonl`),
    fileWatcher: null,
    pollTimer: null,
    fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: true,
    sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(path.sep, 'proj', SESSION_ID, 'subagents'),
    label: 'test session',
    labelSet: false,
    model: null,
    permissionTimer: null,
    permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function subagentPath(session: WatchedSession, ...parts: string[]): string {
  return path.join(session.subagentsDir!, ...parts)
}

function toolUseLine(id: string, name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  })
}

function toolResultLine(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  })
}

describe('Workflow subagent completion', () => {
  let session: WatchedSession
  let events: AgentEvent[]
  let scanCalls: number
  let parser: TranscriptParser

  const process = (line: string) =>
    parser.processTranscriptLine(line, 'Orchestrator', session.pendingToolCalls, session.seenToolUseIds, SESSION_ID, session.seenMessageHashes)

  const completionsFor = (name: string) =>
    events.filter(e => e.type === 'agent_complete' && (e.payload as { name: string }).name === name)

  beforeEach(() => {
    session = makeSession()
    events = []
    scanCalls = 0
    parser = new TranscriptParser({
      emit: (event) => events.push(event),
      elapsed: () => 0,
      getSession: () => session,
      fireSessionLifecycle: () => {},
      emitContextUpdate: () => {},
      scanSubagents: () => { scanCalls++ },
    })
  })

  it('completes idle workflow subagents when the Workflow tool_result arrives', () => {
    const idle = makeSubagentState('workflow-subagent-aaa111')
    session.subagentWatchers.set(subagentPath(session, 'workflows', 'wf_ab-c', 'agent-aaa111.jsonl'), idle)

    process(toolUseLine('toolu_wf1', 'Workflow'))
    process(toolResultLine('toolu_wf1', 'Workflow launched in background. Task ID: 1'))

    assert.equal(completionsFor('workflow-subagent-aaa111').length, 1)
    const ret = events.find(e => e.type === 'subagent_return' && (e.payload as { child: string }).child === 'workflow-subagent-aaa111')
    assert.ok(ret, 'emits subagent_return alongside agent_complete')
    assert.equal((ret!.payload as { parent: string }).parent, 'Orchestrator')
    assert.equal(idle.completed, true)
    assert.equal(scanCalls, 1, 're-scans the subagents dir before completing (flat-watch fallback may lag)')
  })

  it('leaves busy agents (concurrent Workflow) and flat Task/Agent subagents alone', () => {
    const busy = makeSubagentState('workflow-subagent-bbb222', {
      pendingToolCalls: new Map([['toolu_x', { name: 'Bash', args: '', startTime: Date.now() }]]),
    })
    const flat = makeSubagentState('Explore codebase')
    session.subagentWatchers.set(subagentPath(session, 'workflows', 'wf_zz-z', 'agent-bbb222.jsonl'), busy)
    session.subagentWatchers.set(subagentPath(session, 'agent-flat1.jsonl'), flat)

    process(toolUseLine('toolu_wf1', 'Workflow'))
    process(toolResultLine('toolu_wf1', 'done'))

    assert.equal(completionsFor('workflow-subagent-bbb222').length, 0)
    assert.equal(completionsFor('Explore codebase').length, 0)
    assert.equal(busy.completed, false)
    assert.equal(flat.completed, false)
  })

  it('does not re-complete already-completed nodes on a second Workflow result', () => {
    const idle = makeSubagentState('workflow-subagent-aaa111')
    session.subagentWatchers.set(subagentPath(session, 'workflows', 'wf_ab-c', 'agent-aaa111.jsonl'), idle)

    process(toolUseLine('toolu_wf1', 'Workflow'))
    process(toolResultLine('toolu_wf1', 'first run done'))
    process(toolUseLine('toolu_wf2', 'Workflow'))
    process(toolResultLine('toolu_wf2', 'second run done'))

    assert.equal(completionsFor('workflow-subagent-aaa111').length, 1)
  })

  it('skips nodes that were never spawned (no visible node to complete)', () => {
    const unspawned = makeSubagentState('workflow-subagent-ccc333', { spawnEmitted: false })
    session.subagentWatchers.set(subagentPath(session, 'workflows', 'wf_ab-c', 'agent-ccc333.jsonl'), unspawned)

    process(toolUseLine('toolu_wf1', 'Workflow'))
    process(toolResultLine('toolu_wf1', 'done'))

    assert.equal(completionsFor('workflow-subagent-ccc333').length, 0)
  })
})
