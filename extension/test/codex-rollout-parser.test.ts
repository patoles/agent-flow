import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CodexRolloutParser, createCodexRolloutState, extractCodexTimestampMs } from '../src/codex-rollout-parser'
import type { AgentEvent } from '../src/protocol'

function parseFixture(name: string): AgentEvent[] {
  const fixturePath = path.join(__dirname, '..', '..', 'test', 'fixtures', name)
  const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n')
  const firstTimestamp = extractCodexTimestampMs(lines[0])
  if (firstTimestamp === null) {
    throw new Error(`Fixture ${name} is missing a valid first timestamp`)
  }

  const events: AgentEvent[] = []
  const parser = new CodexRolloutParser(
    { emit: (event) => events.push(event) },
    'session-codex',
    firstTimestamp,
    createCodexRolloutState(),
  )

  for (const line of lines) {
    parser.processLine(line)
  }

  return events
}

test('Codex rollout parser normalizes messages, tools, and web search', () => {
  const events = parseFixture('codex-rollout-parent.jsonl')

  const userMessage = events.find((event) => event.type === 'message' && event.payload.role === 'user')
  assert.ok(userMessage)
  assert.equal(userMessage.payload.content, 'Please add Codex support to Agent Flow.')

  const bashStart = events.find((event) => event.type === 'tool_call_start' && event.payload.tool === 'Bash')
  assert.ok(bashStart)
  assert.equal(bashStart.payload.args, 'rg --files extension/src')

  const bashEnd = events.find((event) => event.type === 'tool_call_end' && event.payload.tool === 'Bash')
  assert.ok(bashEnd)
  assert.match(String(bashEnd.payload.result), /extension\.ts/)

  const patchStart = events.find((event) => event.type === 'tool_call_start' && event.payload.tool === 'Patch')
  assert.ok(patchStart)
  assert.match(String(patchStart.payload.args), /extension\.ts/)

  const webSearchEnd = events.find((event) => event.type === 'tool_call_end' && event.payload.tool === 'WebSearch')
  assert.ok(webSearchEnd)
  assert.equal(webSearchEnd.payload.result, 'Search completed')

  assert.ok(events.some((event) => event.type === 'context_update'))
  assert.ok(events.every((event) => event.sessionId === 'session-codex'))
})

test('Codex rollout parser emits subagent lifecycle and suppresses raw notification chat', () => {
  const events = parseFixture('codex-rollout-parent.jsonl')

  const dispatch = events.find((event) => event.type === 'subagent_dispatch')
  assert.ok(dispatch)
  assert.equal(dispatch.payload.parent, 'orchestrator')
  assert.equal(dispatch.payload.child, 'Turing')

  const childSpawn = events.find((event) => event.type === 'agent_spawn' && event.payload.name === 'Turing')
  assert.ok(childSpawn)

  const waitStart = events.find((event) => event.type === 'tool_call_start' && event.payload.tool === 'wait_agent')
  assert.ok(waitStart)

  const subagentReturn = events.find((event) => event.type === 'subagent_return')
  assert.ok(subagentReturn)
  assert.equal(subagentReturn.payload.child, 'Turing')
  assert.equal(subagentReturn.payload.summary, 'Found the runtime seams')

  const childComplete = events.find((event) => event.type === 'agent_complete' && event.payload.name === 'Turing')
  assert.ok(childComplete)

  const rawNotificationMessage = events.find((event) =>
    event.type === 'message'
    && typeof event.payload.content === 'string'
    && event.payload.content.includes('<subagent_notification>'))
  assert.equal(rawNotificationMessage, undefined)
})
