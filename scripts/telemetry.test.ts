import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTelemetryClient, isTelemetryEnabled, TELEMETRY_ENDPOINT, TELEMETRY_PUBLISHABLE_KEY } from './telemetry'

function setup() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-tel-'))
}

function makeClient(dir: string) {
  return createTelemetryClient({
    logDir: path.join(dir, 'telemetry'),
    installIdPath: path.join(dir, 'installation-id'),
    // Unroutable so tests never hit the real endpoint.
    endpoint: 'http://127.0.0.1:1',
    apiKey: 'test',
  })
}

function baseEvent() {
  return {
    event_type: 'session_start' as const,
    session_id: 's-1',
    agent_flow_version: '0.0.1',
    os: 'darwin',
    arch: 'arm64',
  }
}

test('hardcoded constants are present', () => {
  assert.match(TELEMETRY_ENDPOINT, /^https:\/\/.+\.supabase\.co$/)
  assert.match(TELEMETRY_PUBLISHABLE_KEY, /^sb_publishable_/)
})

test('isTelemetryEnabled: default (no env) is true', () => {
  assert.equal(isTelemetryEnabled({}), true)
})

test('isTelemetryEnabled: AGENT_FLOW_TELEMETRY=false disables', () => {
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: 'false' }), false)
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: '0' }), false)
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: 'disabled' }), false)
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: '' }), false)
})

test('isTelemetryEnabled: AGENT_FLOW_TELEMETRY=true stays enabled', () => {
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: 'true' }), true)
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: '1' }), true)
})

test('isTelemetryEnabled: DO_NOT_TRACK=1 disables', () => {
  assert.equal(isTelemetryEnabled({ DO_NOT_TRACK: '1' }), false)
  assert.equal(isTelemetryEnabled({ DO_NOT_TRACK: 'true' }), false)
})

test('isTelemetryEnabled: DO_NOT_TRACK wins even when AGENT_FLOW_TELEMETRY=true', () => {
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: 'true', DO_NOT_TRACK: '1' }), false)
})

test('emit appends to JSONL when enabled', async () => {
  const dir = setup()
  const client = makeClient(dir)
  delete process.env.AGENT_FLOW_TELEMETRY
  delete process.env.DO_NOT_TRACK
  await client.init()
  client.emit(baseEvent())
  await client.dispose()
  const jsonl = path.join(dir, 'telemetry', 'events.jsonl')
  const lines = fs.readFileSync(jsonl, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1)
  const e = JSON.parse(lines[0])
  assert.equal(e.v, 1)
  assert.equal(e.event_type, 'session_start')
  assert.match(e.installation_id, /^[0-9a-f-]{36}$/)
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test('disabled via AGENT_FLOW_TELEMETRY=false writes nothing to disk', async () => {
  const dir = setup()
  process.env.AGENT_FLOW_TELEMETRY = 'false'
  try {
    const client = makeClient(dir)
    await client.init()
    client.emit(baseEvent())
    await client.dispose()
    // No events log AND no install-id file — disabled means zero disk footprint.
    assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
    assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
  } finally {
    delete process.env.AGENT_FLOW_TELEMETRY
  }
})

test('disabled via DO_NOT_TRACK=1 writes nothing to disk', async () => {
  const dir = setup()
  process.env.DO_NOT_TRACK = '1'
  try {
    const client = makeClient(dir)
    await client.init()
    client.emit(baseEvent())
    await client.dispose()
    assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
    assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
  } finally {
    delete process.env.DO_NOT_TRACK
  }
})

test('install-id persists across init calls', async () => {
  const dir = setup()
  delete process.env.AGENT_FLOW_TELEMETRY
  delete process.env.DO_NOT_TRACK
  const client1 = makeClient(dir)
  await client1.init()
  client1.emit(baseEvent())
  await client1.dispose()
  const idPath = path.join(dir, 'installation-id')
  const id1 = fs.readFileSync(idPath, 'utf-8').trim()

  const client2 = makeClient(dir)
  await client2.init()
  client2.emit(baseEvent())
  await client2.dispose()
  const lines = fs.readFileSync(path.join(dir, 'telemetry', 'events.jsonl'), 'utf-8').trim().split('\n')
  for (const line of lines) {
    assert.equal(JSON.parse(line).installation_id, id1)
  }
})

test('emit sanitizes session_id', async () => {
  const dir = setup()
  delete process.env.AGENT_FLOW_TELEMETRY
  delete process.env.DO_NOT_TRACK
  const client = makeClient(dir)
  await client.init()
  client.emit({ ...baseEvent(), session_id: 'quote"backslash\\newline\n' })
  await client.dispose()
  const jsonl = path.join(dir, 'telemetry', 'events.jsonl')
  const e = JSON.parse(fs.readFileSync(jsonl, 'utf-8').trim())
  assert.equal(e.session_id, 'quotebackslashnewline')
})
