import { describe, it, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import * as path from 'node:path'
import Module from 'node:module'

import { isLoopbackHost, isAllowedHookRequest } from '../src/request-guard'
import type { HookServer as HookServerType } from '../src/hook-server'
import type { AgentEvent } from '../src/protocol'

describe('isLoopbackHost', () => {
  it('accepts loopback names with or without a port', () => {
    for (const host of ['127.0.0.1:3001', 'localhost:3001', 'LOCALHOST:8080', '[::1]:3001', '127.0.0.1', 'localhost']) {
      assert.equal(isLoopbackHost(host), true, host)
    }
  })

  it('rejects other hosts, including ones that only start like loopback', () => {
    for (const host of ['attacker.example.com:3001', '127.0.0.1.attacker.example.com', 'localhost.attacker.example.com:3001', '0.0.0.0:3001', '192.168.1.10:3001', '']) {
      assert.equal(isLoopbackHost(host), false, host)
    }
    assert.equal(isLoopbackHost(undefined), false)
  })
})

describe('isAllowedHookRequest', () => {
  it('accepts a loopback request without Origin, as hook.js sends', () => {
    assert.equal(isAllowedHookRequest({ host: '127.0.0.1:4567' }), true)
  })

  it('rejects any request that carries Origin, since only browsers send it', () => {
    assert.equal(isAllowedHookRequest({ host: '127.0.0.1:4567', origin: 'https://attacker.example.com' }), false)
    assert.equal(isAllowedHookRequest({ host: '127.0.0.1:4567', origin: 'null' }), false)
  })

  it('rejects a foreign Host', () => {
    assert.equal(isAllowedHookRequest({ host: 'attacker.example.com:4567' }), false)
  })
})

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

function post(port: number, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', headers }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('HookServer request checks', () => {
  let server: HookServerType
  let port: number
  const events: AgentEvent[] = []
  const payload = (id: string) => JSON.stringify({
    session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' },
  })

  before(async () => {
    const { HookServer } = requireWithVscodeShim<typeof import('../src/hook-server')>('../src/hook-server')
    server = new HookServer()
    server.onEvent(e => events.push(e))
    port = await server.start()
  })

  after(() => server.dispose())

  it('accepts a hook.js-style request and emits its events', async () => {
    const status = await post(port, { 'Content-Type': 'application/json' }, payload('legit'))
    assert.equal(status, 200)
    assert.ok(events.some(e => e.sessionId === 'legit'))
  })

  it('rejects a browser-style cross-origin POST without emitting anything', async () => {
    const status = await post(port, { 'Content-Type': 'text/plain', Origin: 'https://attacker.example.com' }, payload('from-page'))
    assert.equal(status, 403)
    assert.ok(!events.some(e => e.sessionId === 'from-page'))
  })

  it('rejects a DNS-rebinding request with a foreign Host', async () => {
    const status = await post(port, { 'Content-Type': 'application/json', Host: `attacker.example.com:${port}` }, payload('rebound'))
    assert.equal(status, 403)
    assert.ok(!events.some(e => e.sessionId === 'rebound'))
  })
})
