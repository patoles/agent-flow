/**
 * Unit tests for CodexRolloutParser.
 *
 * Feeds a hand-crafted rollout fixture through the parser and asserts the
 * resulting event stream and final state. The fixture covers every supported
 * record type plus the tricky edge cases (IDE-wrapper extraction, pure-injection
 * filtering, developer-role skip, partial/malformed lines, unknown types, token
 * count authority, compaction reset).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CodexRolloutParser,
  createCodexRolloutState,
  type CodexParserDelegate,
} from '../src/codex-rollout-parser'
import type { AgentEvent } from '../src/protocol'

/** Run the sample fixture through the parser, returning all emitted events
 *  and the final rollout state. */
function runFixture() {
  const file = path.join(__dirname, 'fixtures', 'codex-rollout-sample.jsonl')
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  const events: AgentEvent[] = []
  const labels: string[] = []
  const delegate: CodexParserDelegate = {
    emit: (e) => events.push(e),
    elapsed: () => 0,
    setLabel: (l) => labels.push(l),
  }
  const parser = new CodexRolloutParser(delegate)
  const state = createCodexRolloutState()
  for (const line of lines) parser.processLine(line, state)
  return { events, labels, state }
}

describe('CodexRolloutParser', () => {
  it('emits agent_spawn exactly once on the first record', () => {
    const { events } = runFixture()
    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].payload.isMain, true)
  })

  it('detects the model from turn_context (not session_meta)', () => {
    const { events, state } = runFixture()
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(detects.length, 1)
    assert.equal(detects[0].payload.model, 'gpt-5.3-codex')
    assert.equal(state.model, 'gpt-5.3-codex')
  })

  it('filters pure injections (AGENTS.md, environment_context) from user messages', () => {
    const { events } = runFixture()
    const userMessages = events.filter(
      e => e.type === 'message' && e.payload.role === 'user',
    )
    // 3 user messages in the fixture but 2 are pure injections; only the
    // "# Context from my IDE setup:" wrapped one survives.
    assert.equal(userMessages.length, 1)
    assert.equal(
      userMessages[0].payload.content,
      'List files in the current directory.',
    )
  })

  it('skips messages with the developer role', () => {
    const { events } = runFixture()
    const hasDeveloper = events.some(
      e => e.type === 'message' && e.payload.role === 'developer',
    )
    assert.equal(hasDeveloper, false)
  })

  it('extracts the assistant message', () => {
    const { events } = runFixture()
    const asst = events.filter(
      e => e.type === 'message' && e.payload.role === 'assistant',
    )
    assert.equal(asst.length, 1)
    assert.equal(asst[0].payload.content, 'Found 1 file: foo.ts')
  })

  it('emits reasoning from event_msg.agent_reasoning with role=thinking', () => {
    const { events } = runFixture()
    const thinking = events.filter(
      e => e.type === 'message' && e.payload.role === 'thinking',
    )
    assert.equal(thinking.length, 1)
    assert.equal(thinking[0].payload.content, '**Planning directory listing**')
  })

  it('pairs function_call with function_call_output by call_id', () => {
    const { events, state } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'exec_command')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'exec_command')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.ok(!state.pendingToolCalls.has('call-exec-1'), 'pending should be cleared on output')
  })

  it('unwraps the nested JSON envelope in function_call_output', () => {
    const { events } = runFixture()
    const end = events.find(e => e.type === 'tool_call_end' && e.payload.tool === 'exec_command')
    assert.ok(end)
    // extractOutputString should unwrap { "output": "..." } to the raw text.
    assert.ok(String(end!.payload.result).includes('total 8'))
  })

  it('handles apply_patch via custom_tool_call with raw patch body', () => {
    const { events, state } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'apply_patch')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'apply_patch')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.ok(!state.pendingToolCalls.has('call-patch-1'))
  })

  it('emits WebSearch as a self-contained start+end pair', () => {
    const { events } = runFixture()
    const starts = events.filter(e => e.type === 'tool_call_start' && e.payload.tool === 'WebSearch')
    const ends = events.filter(e => e.type === 'tool_call_end' && e.payload.tool === 'WebSearch')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.equal(starts[0].payload.args, 'typescript release notes')
  })

  it('uses last_token_usage from token_count as authoritative context fill', () => {
    const { events, state } = runFixture()
    assert.equal(state.lastReportedTokens, 12000)
    assert.equal(state.reportedContextWindow, 258400)
    // Every context_update after the token_count carries the authoritative
    // tokensMax from model_context_window.
    const updates = events.filter(e => e.type === 'context_update')
    const last = updates[updates.length - 1]
    assert.ok(last)
    assert.equal(last.payload.tokensMax, 258400)
  })

  it('flags the context_update emitted from token_count as authoritative', () => {
    const { events } = runFixture()
    const updates = events.filter(e => e.type === 'context_update')
    const authoritative = updates.filter(e => e.payload.isAuthoritative === true)
    // Exactly one context_update carries the flag — the one emitted directly
    // from handleTokenCount. The UI uses this to smooth the estimate→authority
    // transition instead of jumping.
    assert.equal(authoritative.length, 1)
    assert.equal(authoritative[0].payload.tokens, 12000)
    // Non-authoritative updates must not leak the flag.
    const flagless = updates.filter(e => e.payload.isAuthoritative !== true)
    for (const e of flagless) assert.equal(e.payload.isAuthoritative, undefined)
  })

  it('resets the breakdown on a compacted record', () => {
    const { state } = runFixture()
    // After compaction, reasoning + subagentResults should be zeroed.
    assert.equal(state.contextBreakdown.reasoning, 0)
    assert.equal(state.contextBreakdown.subagentResults, 0)
    // User tokens should reflect the replacement_history summary.
    assert.ok(state.contextBreakdown.userMessages > 0)
  })

  it('tolerates malformed lines and unknown top-level types', () => {
    // The fixture contains one non-JSON line and one unknown_future_type record.
    // Neither should throw or corrupt state; just flow through to the events
    // that follow from valid records.
    const { events } = runFixture()
    // We should still have at least one spawn + model_detected, proving
    // earlier records processed without the bad lines aborting the stream.
    assert.ok(events.some(e => e.type === 'agent_spawn'))
    assert.ok(events.some(e => e.type === 'model_detected'))
  })

  it('tool call counts balance: every start has a matching end', () => {
    const { state } = runFixture()
    // After the fixture, no pending tool calls should remain.
    assert.equal(state.pendingToolCalls.size, 0)
  })

  it('records the label from the first real user prompt', () => {
    const { labels, state } = runFixture()
    assert.ok(labels.length >= 1)
    assert.equal(state.label, 'List files in the current directory.')
  })

  it('only emits model_detected when the model changes', () => {
    // Feed the same turn_context.model twice and confirm a single emit.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({
      emit: (e) => events.push(e),
      elapsed: () => 0,
    })
    const state = createCodexRolloutState()
    const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } })
    parser.processLine(turn, state)
    parser.processLine(turn, state)
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(detects.length, 1)
  })

  it('tolerates records arriving out of order (turn_context before session_meta)', () => {
    // If Codex ever writes turn_context as the first record, we should still
    // emit agent_spawn (once) and detect the model without crashing.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }), state)
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    const spawns = events.filter(e => e.type === 'agent_spawn')
    const detects = events.filter(e => e.type === 'model_detected')
    assert.equal(spawns.length, 1)
    assert.equal(detects.length, 1)
    assert.equal(detects[0].payload.model, 'gpt-5.3-codex')
  })

  it('leaves an orphaned tool call pending when the output never arrives', () => {
    // A transcript we're tailing mid-turn might have a function_call without
    // its matching function_call_output yet. The start event should emit, the
    // end should not, and the pending map should retain the call so the
    // eventual output still resolves it.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'orphan-1' },
    }), state)
    const starts = events.filter(e => e.type === 'tool_call_start')
    const ends = events.filter(e => e.type === 'tool_call_end')
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 0)
    assert.equal(state.pendingToolCalls.size, 1)
    assert.ok(state.pendingToolCalls.has('orphan-1'))
  })

  it('resets breakdown deterministically across an oversized compaction', () => {
    // Stress the compaction path with a large replacement_history to make
    // sure the per-entry loop doesn't overflow estimation buckets and that
    // non-user/non-tool entries don't leak into counts.
    const events: AgentEvent[] = []
    const parser = new CodexRolloutParser({ emit: (e) => events.push(e), elapsed: () => 0 })
    const state = createCodexRolloutState()
    // Pre-populate some noise in the breakdown so we can verify the reset.
    state.contextBreakdown.reasoning = 9999
    state.contextBreakdown.subagentResults = 8888

    const replacement_history = []
    for (let i = 0; i < 200; i++) {
      replacement_history.push({
        role: 'user',
        content: [{ type: 'input_text', text: `user message ${i} `.repeat(20) }],
      })
      replacement_history.push({
        role: 'tool',
        content: [{ type: 'output_text', text: `tool result ${i} `.repeat(20) }],
      })
      // Noise the handler should ignore — neither user nor tool.
      replacement_history.push({ role: 'assistant', content: [{ type: 'output_text', text: 'ignored' }] })
    }

    parser.processLine(JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } }), state)
    parser.processLine(JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history } }), state)

    assert.equal(state.contextBreakdown.reasoning, 0)
    assert.equal(state.contextBreakdown.subagentResults, 0)
    assert.ok(state.contextBreakdown.userMessages > 0)
    assert.ok(state.contextBreakdown.toolResults > 0)
    // Sanity: the bucketed counts are finite and not NaN.
    assert.ok(Number.isFinite(state.contextBreakdown.userMessages))
    assert.ok(Number.isFinite(state.contextBreakdown.toolResults))
  })
})
