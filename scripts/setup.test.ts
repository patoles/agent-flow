import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { configureHooks, isAgentFlowHook, isAlreadySetup } from './setup'

const HOOK_CMD = '"/usr/bin/node" "/home/u/.claude/agent-flow/hook.js"'

function tmpSettings(content?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-setup-'))
  const file = path.join(dir, '.claude', 'settings.json')
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return file
}

function read(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function quietly<T>(fn: () => T): T {
  const { log, error } = console
  console.log = () => {}
  console.error = () => {}
  try { return fn() } finally { console.log = log; console.error = error }
}

const foreignHttp = { hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/session-start' }] }
const foreignCommand = { hooks: [{ type: 'command', command: 'other-tool notify' }] }

test('isAgentFlowHook matches only our own hooks', () => {
  assert.equal(isAgentFlowHook({ hooks: [{ command: HOOK_CMD }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ command: '"C:\\node.exe" "C:\\Users\\u\\.claude\\agent-flow\\hook.js"' }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }), true)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341/' }] }), true)
  assert.equal(isAgentFlowHook(foreignHttp), false)
  assert.equal(isAgentFlowHook({ hooks: [{ type: 'http', url: 'http://127.0.0.1:8080/hooks' }] }), false)
  assert.equal(isAgentFlowHook(foreignCommand), false)
  assert.equal(isAgentFlowHook({}), false)
})

test("configureHooks keeps other tools' loopback HTTP hooks (#73)", () => {
  const file = tmpSettings({ hooks: { SessionStart: [foreignHttp], Stop: [foreignHttp, foreignCommand] } })
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), true)

  const { hooks } = read(file)
  assert.deepEqual(hooks.SessionStart[0], foreignHttp)
  assert.deepEqual(hooks.Stop.slice(0, 2), [foreignHttp, foreignCommand])
  for (const event of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']) {
    assert.equal(hooks[event].filter(isAgentFlowHook).length, 1, event)
  }
})

test('configureHooks replaces previous Agent Flow hooks instead of duplicating them', () => {
  const legacy = { hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }
  const old = { hooks: [{ type: 'command', command: '"/old/node" "/home/u/.claude/agent-flow/hook.js"', timeout: 2 }] }
  const file = tmpSettings({ hooks: { PreToolUse: [legacy, old, foreignCommand] } })
  quietly(() => configureHooks(file, HOOK_CMD))
  quietly(() => configureHooks(file, HOOK_CMD))

  const { hooks } = read(file)
  assert.deepEqual(hooks.PreToolUse, [
    foreignCommand,
    { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] },
  ])
})

test('configureHooks preserves unrelated settings', () => {
  const file = tmpSettings({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } })
  quietly(() => configureHooks(file, HOOK_CMD))
  const settings = read(file)
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
  assert.deepEqual(settings.env, { FOO: '1' })
})

test('configureHooks leaves an unparseable settings file untouched', () => {
  const broken = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n}\n'
  const file = tmpSettings(broken)
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), false)
  assert.equal(fs.readFileSync(file, 'utf-8'), broken)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
})

test('configureHooks creates settings.json when missing', () => {
  const file = tmpSettings()
  assert.equal(quietly(() => configureHooks(file, HOOK_CMD)), true)
  assert.equal(read(file).hooks.SessionStart.length, 1)
})

test("isAlreadySetup ignores other tools' loopback hooks", () => {
  const file = tmpSettings({ hooks: { SessionStart: [foreignHttp] } })
  const hookScript = path.join(path.dirname(file), 'hook.js')
  fs.writeFileSync(hookScript, '')
  assert.equal(isAlreadySetup(file, hookScript), false)

  quietly(() => configureHooks(file, HOOK_CMD))
  assert.equal(isAlreadySetup(file, hookScript), true)
})
