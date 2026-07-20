import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveProjectWorktree,
  groupSessions,
  UNGROUPED_PROJECT,
} from './session-grouping'
import type { SessionInfo } from './bridge-types'

test('AO worktree path → project + worktree (Windows separators)', () => {
  assert.deepEqual(
    deriveProjectWorktree('C:\\Users\\nicol\\.ao\\data\\worktrees\\agent-flow\\agent-flow-1'),
    { project: 'agent-flow', worktree: 'agent-flow-1' },
  )
})

test('AO worktree path → project + worktree (POSIX separators)', () => {
  assert.deepEqual(
    deriveProjectWorktree('/home/u/.ao/data/worktrees/my-repo/session-3'),
    { project: 'my-repo', worktree: 'session-3' },
  )
})

test('AO worktree with deeper cwd keeps the worktree segment', () => {
  assert.deepEqual(
    deriveProjectWorktree('/home/u/.ao/data/worktrees/repo/wt-1/packages/api'),
    { project: 'repo', worktree: 'wt-1' },
  )
})

test('PROJETS path → project, no worktree', () => {
  assert.deepEqual(
    deriveProjectWorktree('C:\\Users\\nicol\\Desktop\\PROJETS\\agent-flow'),
    { project: 'agent-flow', worktree: null },
  )
})

test('PROJETS path is case-insensitive on the marker', () => {
  assert.deepEqual(
    deriveProjectWorktree('/home/u/projets/cool-tool/src'),
    { project: 'cool-tool', worktree: null },
  )
})

test('unknown layout falls back to last segment', () => {
  assert.deepEqual(
    deriveProjectWorktree('/var/tmp/scratch-dir'),
    { project: 'scratch-dir', worktree: null },
  )
})

test('empty / missing cwd → ungrouped bucket', () => {
  const expected = { project: UNGROUPED_PROJECT, worktree: null }
  assert.deepEqual(deriveProjectWorktree(undefined), expected)
  assert.deepEqual(deriveProjectWorktree(null), expected)
  assert.deepEqual(deriveProjectWorktree(''), expected)
  assert.deepEqual(deriveProjectWorktree('   '), expected)
})

function session(id: string, cwd?: string): SessionInfo {
  return { id, label: id, status: 'active', startTime: 0, lastActivityTime: 0, cwd }
}

test('groupSessions buckets by project then worktree, Other last', () => {
  const groups = groupSessions([
    session('a', 'C:\\x\\.ao\\data\\worktrees\\repo-b\\wt-2'),
    session('b', 'C:\\x\\.ao\\data\\worktrees\\repo-a\\wt-1'),
    session('c', 'C:\\x\\.ao\\data\\worktrees\\repo-a\\wt-2'),
    session('d'), // no cwd → Other
    session('e', '/home/u/PROJETS/repo-a'), // same project name, no worktree
  ])

  assert.deepEqual(groups.map(g => g.project), ['repo-a', 'repo-b', UNGROUPED_PROJECT])

  const repoA = groups[0]
  assert.equal(repoA.count, 3)
  // worktree=null bucket first (the PROJETS session), then wt-1, wt-2
  assert.deepEqual(repoA.worktrees.map(w => w.worktree), [null, 'wt-1', 'wt-2'])
  assert.deepEqual(repoA.worktrees[0].sessions.map(s => s.id), ['e'])
  assert.deepEqual(repoA.worktrees[2].sessions.map(s => s.id), ['c'])

  const other = groups[2]
  assert.deepEqual(other.worktrees[0].sessions.map(s => s.id), ['d'])
})
