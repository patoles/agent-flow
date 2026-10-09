/**
 * Unit tests for settings.json hook handling.
 *
 * The invariant: Agent Flow only ever touches its own hooks. Other tools
 * register loopback HTTP hooks too (#73), and a settings file we can't parse
 * must never be overwritten.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isLegacyAgentFlowHookUrl, isAgentFlowHook, hasAgentFlowHook,
  mergeAgentFlowHooks, migrateLegacyHttpHooks,
  readSettingsFile, writeJsonAtomic,
} from '../src/hook-entries'

const HOOK_CMD = '"/usr/bin/node" "/home/u/.claude/agent-flow/hook.js"'
const foreignHttp = () => ({ hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/session-start' }] })

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-hooks-'))
}

describe('isLegacyAgentFlowHookUrl', () => {
  it('matches only the bare hook server origin', () => {
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:52341'), true)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:52341/'), true)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:19847/hook/abc/stop'), false)
    assert.equal(isLegacyAgentFlowHookUrl('http://127.0.0.1:8080/?x=1'), false)
    assert.equal(isLegacyAgentFlowHookUrl('http://localhost:52341'), false)
    assert.equal(isLegacyAgentFlowHookUrl(undefined), false)
  })
})

describe('isAgentFlowHook', () => {
  it('matches our command hook on POSIX and Windows paths', () => {
    assert.equal(isAgentFlowHook({ hooks: [{ command: HOOK_CMD }] }), true)
    assert.equal(isAgentFlowHook({ hooks: [{ command: '"C:\\node.exe" "C:\\Users\\u\\.claude\\agent-flow\\hook.js"' }] }), true)
  })

  it("does not match other tools' hooks", () => {
    assert.equal(isAgentFlowHook(foreignHttp()), false)
    assert.equal(isAgentFlowHook({ hooks: [{ command: 'other-tool notify' }] }), false)
    assert.equal(isAgentFlowHook({}), false)
  })
})

describe('mergeAgentFlowHooks', () => {
  it('replaces our entries and keeps everything else', () => {
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        SessionStart: [foreignHttp(), { hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '"/old/node" "/x/.claude/agent-flow/hook.js"' }] }],
        UserPromptSubmit: [foreignHttp()],
      },
    }
    const entry = { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] }
    mergeAgentFlowHooks(settings, entry, ['SessionStart', 'Stop'])
    mergeAgentFlowHooks(settings, entry, ['SessionStart', 'Stop'])

    const hooks = settings.hooks as Record<string, unknown[]>
    assert.deepEqual(hooks.SessionStart, [foreignHttp(), entry])
    assert.deepEqual(hooks.Stop, [entry])
    assert.deepEqual(hooks.UserPromptSubmit, [foreignHttp()])
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
  })
})

describe('hasAgentFlowHook', () => {
  it('is false when only another tool has loopback hooks', () => {
    assert.equal(hasAgentFlowHook({ hooks: { SessionStart: [foreignHttp()] } }), false)
    assert.equal(hasAgentFlowHook({ hooks: { SessionStart: [{ hooks: [{ command: HOOK_CMD }] }] } }), true)
    assert.equal(hasAgentFlowHook({}), false)
  })
})

describe('migrateLegacyHttpHooks', () => {
  it('rewrites legacy Agent Flow HTTP hooks and leaves foreign ones alone', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
        Stop: [foreignHttp()],
      },
    }
    assert.equal(migrateLegacyHttpHooks(settings, HOOK_CMD, 2), true)
    const hooks = settings.hooks as Record<string, unknown[]>
    assert.deepEqual(hooks.PreToolUse, [{ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2 }] }])
    assert.deepEqual(hooks.Stop, [foreignHttp()])
  })

  it('reports no change when there is nothing to migrate', () => {
    const settings = { hooks: { Stop: [foreignHttp()] } }
    assert.equal(migrateLegacyHttpHooks(settings, HOOK_CMD, 2), false)
    assert.deepEqual(settings, { hooks: { Stop: [foreignHttp()] } })
  })
})

describe('readSettingsFile', () => {
  it('treats a missing or empty file as empty settings', () => {
    const dir = tmpDir()
    assert.deepEqual(readSettingsFile(path.join(dir, 'missing.json')), { ok: true, settings: {} })
    fs.writeFileSync(path.join(dir, 'empty.json'), '  \n')
    assert.deepEqual(readSettingsFile(path.join(dir, 'empty.json')), { ok: true, settings: {} })
  })

  it('reports invalid JSON and non-object values as errors', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'trailing-comma.json'), '{ "a": 1, }')
    fs.writeFileSync(path.join(dir, 'array.json'), '[]')
    assert.equal(readSettingsFile(path.join(dir, 'trailing-comma.json')).ok, false)
    assert.equal(readSettingsFile(path.join(dir, 'array.json')).ok, false)
  })
})

describe('writeJsonAtomic', () => {
  it('writes the file, creating parent dirs, and leaves no temp file behind', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'nested', 'settings.json')
    writeJsonAtomic(file, { a: 1 })
    assert.equal(fs.readFileSync(file, 'utf-8'), '{\n  "a": 1\n}\n')
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
  })
})
