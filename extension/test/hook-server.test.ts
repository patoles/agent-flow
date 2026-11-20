import { describe, it, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import * as path from 'node:path'
import Module from 'node:module'

import type { HookServer as HookServerType } from '../src/hook-server'
import type { AgentEvent } from '../src/protocol'

// hook-server.ts imports `vscode`; point it at the shim the relay build uses.
function requireWithVscodeShim<T>(id: string): T {
  const shim = path.resolve(__dirname, '../../scripts/vscode-shim.js')
  const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
  const original = M._resolveFilename
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? shim : original.call(this, request, ...rest)
  }
  try {
    return require(id) as T
  } finally {
    M._resolveFilename = original
  }
}

function post(port: number, body: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('HookServer tool use ids', () => {
  let server: HookServerType
  let port: number
  const events: AgentEvent[] = []
  const hook = (session: string, event: string, toolUseId?: string) => ({
    session_id: session,
    hook_event_name: event,
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/a.ts' },
    tool_response: 'ok',
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  })
  const toolEvents = (session: string) =>
    events
      .filter(e => e.sessionId === session && (e.type === 'tool_call_start' || e.type === 'tool_call_end'))
      .map(e => [e.type, e.payload.toolUseId])

  before(async () => {
    const { HookServer } = requireWithVscodeShim<typeof import('../src/hook-server')>('../src/hook-server')
    server = new HookServer()
    server.onEvent(e => events.push(e))
    port = await server.start()
  })

  after(() => server.dispose())

  it('passes tool_use_id on to tool_call_start and tool_call_end', async () => {
    assert.equal(await post(port, hook('ids', 'PreToolUse', 'toolu_1')), 200)
    assert.equal(await post(port, hook('ids', 'PreToolUse', 'toolu_2')), 200)
    assert.equal(await post(port, hook('ids', 'PostToolUse', 'toolu_2')), 200)
    assert.equal(await post(port, hook('ids', 'PostToolUseFailure', 'toolu_1')), 200)
    assert.deepEqual(toolEvents('ids'), [
      ['tool_call_start', 'toolu_1'],
      ['tool_call_start', 'toolu_2'],
      ['tool_call_end', 'toolu_2'],
      ['tool_call_end', 'toolu_1'],
    ])
  })

  it('leaves toolUseId undefined when the hook has no tool_use_id', async () => {
    assert.equal(await post(port, hook('no-ids', 'PreToolUse')), 200)
    assert.equal(await post(port, hook('no-ids', 'PostToolUse')), 200)
    assert.deepEqual(toolEvents('no-ids'), [
      ['tool_call_start', undefined],
      ['tool_call_end', undefined],
    ])
  })
})
