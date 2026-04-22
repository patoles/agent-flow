import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { syncOnce } from './sync'

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-sync-'))
  return {
    jsonlPath: path.join(dir, 'events.jsonl'),
    cursorPath: path.join(dir, '.cursor'),
  }
}

function makeEvent(i: number) {
  return JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    event_type: 'session_start',
    installation_id: 'a1b2c3d4-5678-4abc-9def-000000000000',
    session_id: `s-${i}`,
    agent_flow_version: '0.0.1',
    os: 'darwin',
    arch: 'arm64',
  })
}

test('noop when jsonl does not exist', async () => {
  const { jsonlPath, cursorPath } = setup()
  const result = await syncOnce({
    jsonlPath,
    cursorPath,
    endpoint: 'http://unused',
    apiKey: 'x',
    fetch: (async () => { throw new Error('should not fetch') }) as unknown as typeof fetch,
  })
  assert.equal(result.sent, 0)
  assert.equal(result.reason, 'no_events_file')
})

test('noop when cursor is caught up', async () => {
  const { jsonlPath, cursorPath } = setup()
  fs.writeFileSync(jsonlPath, makeEvent(1) + '\n')
  fs.writeFileSync(cursorPath, '1')
  const result = await syncOnce({
    jsonlPath,
    cursorPath,
    endpoint: 'http://unused',
    apiKey: 'x',
    fetch: (async () => { throw new Error('should not fetch') }) as unknown as typeof fetch,
  })
  assert.equal(result.sent, 0)
  assert.equal(result.reason, 'cursor_caught_up')
})

test('sends unsent events and advances cursor on 2xx + inserted>0', async () => {
  const { jsonlPath, cursorPath } = setup()
  fs.writeFileSync(jsonlPath, [makeEvent(1), makeEvent(2), makeEvent(3)].join('\n') + '\n')
  let captured: string | undefined
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    captured = init.body
    return new Response(JSON.stringify({ inserted: 3, rejected: 0 }), { status: 200 })
  }) as unknown as typeof fetch
  const result = await syncOnce({ jsonlPath, cursorPath, endpoint: 'http://e', apiKey: 'k', fetch: fakeFetch })
  assert.equal(result.sent, 3)
  const parsed = JSON.parse(captured!)
  assert.equal(parsed.length, 3)
  assert.equal(fs.readFileSync(cursorPath, 'utf-8').trim(), '3')
})

test('does not advance cursor when inserted==0', async () => {
  const { jsonlPath, cursorPath } = setup()
  fs.writeFileSync(jsonlPath, makeEvent(1) + '\n')
  const fakeFetch = (async () => new Response(JSON.stringify({ inserted: 0, rejected: 1 }), { status: 200 })) as unknown as typeof fetch
  const result = await syncOnce({ jsonlPath, cursorPath, endpoint: 'http://e', apiKey: 'k', fetch: fakeFetch })
  assert.equal(result.sent, 0)
  assert.equal(fs.existsSync(cursorPath), false)
})

test('does not advance cursor on 5xx', async () => {
  const { jsonlPath, cursorPath } = setup()
  fs.writeFileSync(jsonlPath, makeEvent(1) + '\n')
  const fakeFetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
  const result = await syncOnce({ jsonlPath, cursorPath, endpoint: 'http://e', apiKey: 'k', fetch: fakeFetch })
  assert.equal(result.sent, 0)
  assert.equal(result.reason, 'http_error')
})

test('caps batch at 100 events', async () => {
  const { jsonlPath, cursorPath } = setup()
  const lines = Array.from({ length: 150 }, (_, i) => makeEvent(i)).join('\n') + '\n'
  fs.writeFileSync(jsonlPath, lines)
  let batchSize = 0
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    batchSize = JSON.parse(init.body).length
    return new Response(JSON.stringify({ inserted: batchSize, rejected: 0 }), { status: 200 })
  }) as unknown as typeof fetch
  const result = await syncOnce({ jsonlPath, cursorPath, endpoint: 'http://e', apiKey: 'k', fetch: fakeFetch })
  assert.equal(result.sent, 100)
  assert.equal(batchSize, 100)
})
