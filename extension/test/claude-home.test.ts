import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as os from 'os'
import * as path from 'path'
import { claudeConfigDirs, claudeProjectDirs, claudeSettingsPaths } from '../src/claude-home'

const HOME = os.homedir()
const DEFAULT = path.join(HOME, '.claude')

test('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
  assert.deepEqual(claudeConfigDirs({}), [DEFAULT])
})

test('falls back to ~/.claude for empty and whitespace-only values', () => {
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '' }), [DEFAULT])
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '   ' }), [DEFAULT])
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: ',,' }), [DEFAULT])
})

test('honours a single config dir', () => {
  const personal = path.join(HOME, '.claude-personal')
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: personal }), [personal])
})

test('splits a comma-separated list and preserves order', () => {
  const work = path.join(HOME, '.claude')
  const personal = path.join(HOME, '.claude-personal')
  assert.deepEqual(
    claudeConfigDirs({ CLAUDE_CONFIG_DIR: `${work},${personal}` }),
    [work, personal],
  )
  assert.deepEqual(
    claudeConfigDirs({ CLAUDE_CONFIG_DIR: `${personal},${work}` }),
    [personal, work],
  )
})

test('trims whitespace around entries', () => {
  const personal = path.join(HOME, '.claude-personal')
  assert.deepEqual(
    claudeConfigDirs({ CLAUDE_CONFIG_DIR: ` ${DEFAULT} , ${personal} ` }),
    [DEFAULT, personal],
  )
})

test('expands a leading tilde', () => {
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '~/.claude-personal' }),
    [path.join(HOME, '.claude-personal')])
  assert.deepEqual(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '~' }), [HOME])
})

test('does not expand a tilde that is not a home reference', () => {
  const dirs = claudeConfigDirs({ CLAUDE_CONFIG_DIR: '/tmp/~claude' })
  assert.deepEqual(dirs, [path.resolve('/tmp/~claude')])
})

test('deduplicates repeated entries so no directory is watched twice', () => {
  assert.deepEqual(
    claudeConfigDirs({ CLAUDE_CONFIG_DIR: `${DEFAULT},${DEFAULT}` }),
    [DEFAULT],
  )
  // Same directory written two different ways still collapses to one.
  assert.deepEqual(
    claudeConfigDirs({ CLAUDE_CONFIG_DIR: `${DEFAULT},${DEFAULT}/.` }),
    [DEFAULT],
  )
})

test('resolves relative entries to absolute paths', () => {
  const dirs = claudeConfigDirs({ CLAUDE_CONFIG_DIR: 'relative-config' })
  assert.equal(dirs.length, 1)
  assert.ok(path.isAbsolute(dirs[0]))
  assert.equal(dirs[0], path.resolve('relative-config'))
})

test('derives projects/ under every config dir', () => {
  const personal = path.join(HOME, '.claude-personal')
  assert.deepEqual(
    claudeProjectDirs({ CLAUDE_CONFIG_DIR: `${DEFAULT},${personal}` }),
    [path.join(DEFAULT, 'projects'), path.join(personal, 'projects')],
  )
})

test('derives settings.json under every config dir', () => {
  const personal = path.join(HOME, '.claude-personal')
  assert.deepEqual(
    claudeSettingsPaths({ CLAUDE_CONFIG_DIR: `${DEFAULT},${personal}` }),
    [path.join(DEFAULT, 'settings.json'), path.join(personal, 'settings.json')],
  )
})
