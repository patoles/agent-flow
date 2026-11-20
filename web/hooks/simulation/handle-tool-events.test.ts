import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent } from '@/lib/agent-types'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import type { MutableEventState, ProcessEventContext } from './process-event'

function setup() {
  const state: MutableEventState = {
    agents: new Map([['orchestrator', { name: 'orchestrator', toolCalls: 0, tokensUsed: 0 } as Agent]]),
    toolCalls: new Map(), particles: [], edges: [], discoveries: [],
    fileAttention: new Map(), timelineEntries: new Map(), conversations: new Map(),
  }
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000, blockIdCounter: { current: 0 }, skipForceSync: false,
  }
  const start = (time: number, file: string, toolUseId?: string) => handleToolCallStart(
    { agent: 'orchestrator', tool: 'Read', args: file, inputData: { file_path: file }, toolUseId }, time, state, ctx)
  const end = (time: number, toolUseId?: string, tokenCost?: number) => handleToolCallEnd(
    { agent: 'orchestrator', tool: 'Read', result: 'ok', tokenCost, toolUseId }, time, state, ctx)
  const states = () => Object.fromEntries([...state.toolCalls.values()].map(tc => [tc.args, tc.state]))
  return { state, start, end, states }
}

test('keeps parallel calls to the same tool apart by toolUseId (#107)', () => {
  const { state, start, states } = setup()
  // Parallel calls from one assistant message land in the same frame
  start(10, 'src/a.ts', 'toolu_a')
  start(10, 'src/b.ts', 'toolu_b')
  start(10, 'src/c.ts', 'toolu_c')
  assert.deepEqual(states(), { 'src/a.ts': 'running', 'src/b.ts': 'running', 'src/c.ts': 'running' })
  assert.deepEqual([...state.fileAttention.keys()], ['src/a.ts', 'src/b.ts', 'src/c.ts'])
})

test('dedupes the same call reported by the hook server and the transcript', () => {
  const { state, start, end } = setup()
  start(10, 'src/a.ts', 'toolu_a')
  start(10.5, 'src/a.ts', 'toolu_a')
  end(11, 'toolu_a')
  start(15, 'src/a.ts', 'toolu_a') // late duplicate after completion
  assert.equal(state.toolCalls.size, 1)
  assert.equal(state.fileAttention.get('src/a.ts')?.reads, 1)
})

test('completes the call the result belongs to, not the first one by name (#107)', () => {
  const { state, start, end, states } = setup()
  start(10, 'src/a.ts', 'toolu_a')
  start(14, 'src/b.ts', 'toolu_b')
  end(15, 'toolu_b', 100)
  assert.deepEqual(states(), { 'src/a.ts': 'running', 'src/b.ts': 'complete' })
  assert.equal(state.fileAttention.get('src/a.ts')?.totalTokens, 0)
  assert.equal(state.fileAttention.get('src/b.ts')?.totalTokens, 100)
})

test('falls back to name matching for events without ids (older recordings)', () => {
  const { start, end, states } = setup()
  start(10, 'src/a.ts')
  start(11, 'src/b.ts') // inside the dedup window: treated as a duplicate, as before
  assert.deepEqual(states(), { 'src/a.ts': 'running' })
  end(12)
  start(20, 'src/c.ts')
  end(21)
  assert.deepEqual(states(), { 'src/a.ts': 'complete', 'src/c.ts': 'complete' })
})
