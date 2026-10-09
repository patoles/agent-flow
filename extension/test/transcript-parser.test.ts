/**
 * Unit tests for TranscriptParser's subagent lifecycle and model detection.
 *
 * Background Agent/Task launches (the Claude Code default) return a
 * tool_result right away that only confirms the launch. The subagent really
 * finishes when a <task-notification> for its tool_use_id arrives (#92).
 * The launch result also carries the subagent's resolved model (#91).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate, parseTaskNotification } from '../src/transcript-parser'
import { AgentEvent, WatchedSession } from '../src/protocol'

const SESSION_ID = 'session-1'

function makeSession(): WatchedSession {
  return {
    sessionId: SESSION_ID,
    filePath: '/tmp/session-1.jsonl',
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
    subagentsDir: null,
    label: 'Session',
    labelSet: true,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null,
    permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function setup() {
  const session = makeSession()
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getSession: (id) => (id === SESSION_ID ? session : undefined),
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  const feed = (entry: unknown, agent = 'orchestrator') => parser.processTranscriptLine(
    JSON.stringify(entry), agent, session.pendingToolCalls, session.seenToolUseIds, SESSION_ID, session.seenMessageHashes,
  )
  return { session, events, parser, feed }
}

function agentToolUse(id: string, description: string) {
  return {
    type: 'assistant', uuid: `a-${id}`,
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'Explore', prompt: 'look around' } },
    ] },
  }
}

function agentToolResult(id: string, toolUseResult?: unknown) {
  return {
    type: 'user', uuid: `r-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] },
    ...(toolUseResult ? { toolUseResult } : {}),
  }
}

function asyncLaunch(resolvedModel = 'claude-sonnet-5[1m]') {
  return { isAsync: true, status: 'async_launched', agentId: 'abc123', description: 'Find callers', resolvedModel }
}

function taskNotification(toolUseId: string, status = 'completed', result = 'Found 3 callers.') {
  return {
    type: 'user', uuid: `n-${toolUseId}-${status}`, origin: { kind: 'task-notification' },
    message: { role: 'user', content: [
      '<task-notification>',
      '<task-id>abc123</task-id>',
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      `<status>${status}</status>`,
      '<summary>Agent "Find callers" finished</summary>',
      `<result>${result}</result>`,
      '</task-notification>',
    ].join('\n') },
  }
}

const ofType = (events: AgentEvent[], type: string) => events.filter(e => e.type === type)

describe('background subagents (#92)', () => {
  it('does not complete a background subagent at launch', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))

    assert.equal(ofType(events, 'agent_spawn').length, 1)
    assert.equal(ofType(events, 'agent_complete').length, 0)
    assert.equal(ofType(events, 'subagent_return').length, 0)
    // The Agent tool call itself still ends (the launch finished)
    assert.equal(ofType(events, 'tool_call_end').length, 1)
  })

  it('completes it when its task-notification arrives', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_1'))

    assert.deepEqual(ofType(events, 'subagent_return').map(e => e.payload), [
      { child: 'Find callers', parent: 'orchestrator', summary: 'Found 3 callers.' },
    ])
    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Find callers' }])
    // The notification is not shown as a user message
    assert.equal(ofType(events, 'message').length, 0)
  })

  it('marks non-completed statuses in the return summary', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_1', 'failed', 'Ran out of turns'))

    assert.equal(ofType(events, 'subagent_return')[0].payload.summary, '[failed] Ran out of turns')
    assert.equal(ofType(events, 'agent_complete').length, 1)
  })

  it('ignores notifications for other background tasks and repeats', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch()))
    feed(taskNotification('toolu_bash'))
    assert.equal(ofType(events, 'agent_complete').length, 0)

    feed(taskNotification('toolu_1'))
    feed({ ...taskNotification('toolu_1'), uuid: 'n-again' })
    assert.equal(ofType(events, 'agent_complete').length, 1)
  })

  it('still completes foreground subagents on their tool_result', () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', { status: 'completed', content: [] }))

    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Find callers' }])
  })

  it('completes subagents launched before attach once their notification arrives', () => {
    const { session, events, parser, feed } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-parser-'))
    const file = path.join(dir, 'session.jsonl')
    const history = [
      agentToolUse('toolu_old', 'Already done'),
      agentToolResult('toolu_old', asyncLaunch()),
      taskNotification('toolu_old'),
      agentToolUse('toolu_live', 'Still running'),
      agentToolResult('toolu_live', asyncLaunch()),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(file, history)
    parser.prescanExistingContent(file, Buffer.byteLength(history), session)

    feed({ ...taskNotification('toolu_old'), uuid: 'n-old-repeat' })
    assert.equal(ofType(events, 'agent_complete').length, 0)

    feed(taskNotification('toolu_live'))
    assert.deepEqual(ofType(events, 'agent_complete').map(e => e.payload), [{ name: 'Still running' }])
  })
})

describe('subagent model (#91)', () => {
  it("emits the subagent's resolved model from the launch result", () => {
    const { events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch('claude-sonnet-5[1m]')))

    const childModels = ofType(events, 'model_detected').filter(e => e.payload.agent === 'Find callers')
    assert.deepEqual(childModels.map(e => e.payload.model), ['claude-sonnet-5[1m]'])
  })

  it("doesn't override a model the subagent's own transcript reported", () => {
    const { session, events, feed } = setup()
    feed(agentToolUse('toolu_1', 'Find callers'))
    session.modelDetectedAgents.set('Find callers', 'claude-haiku-4-5')
    feed(agentToolResult('toolu_1', asyncLaunch('claude-sonnet-5')))

    assert.equal(ofType(events, 'model_detected').filter(e => e.payload.agent === 'Find callers').length, 0)
  })

  it('ignores <synthetic> placeholder models', () => {
    const { session, events, feed } = setup()
    feed({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } })
    feed({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } })
    feed(agentToolUse('toolu_1', 'Find callers'))
    feed(agentToolResult('toolu_1', asyncLaunch('<synthetic>')))

    assert.deepEqual(ofType(events, 'model_detected').map(e => e.payload), [{ agent: 'orchestrator', model: 'claude-opus-5-5' }])
    assert.equal(session.modelDetectedAgents.get('orchestrator'), 'claude-opus-5-5')
  })

  it('ignores <synthetic> when picking the session model during prescan', () => {
    const { session, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-parser-'))
    const file = path.join(dir, 'session.jsonl')
    const history = [
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(file, history)
    parser.prescanExistingContent(file, Buffer.byteLength(history), session)
    assert.equal(session.model, 'claude-opus-5-5')
  })
})

describe('parseTaskNotification', () => {
  it('extracts the tool use id, status and result', () => {
    const text = taskNotification('toolu_9', 'killed', 'a &gt; b').message.content as string
    assert.deepEqual(parseTaskNotification(text), { toolUseId: 'toolu_9', status: 'killed', summary: 'a > b' })
  })

  it('returns null for other content', () => {
    assert.equal(parseTaskNotification('hello'), null)
    assert.equal(parseTaskNotification('<task-notification>\n<status>completed</status>'), null)
  })
})
