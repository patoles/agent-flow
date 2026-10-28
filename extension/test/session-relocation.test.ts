/**
 * Following a session that moved to another project folder (#69).
 *
 * Claude Code 2.1.312 moves `<sessionId>.jsonl` and `<sessionId>/` into the
 * worktree's project folder when a session runs EnterWorktree. Older versions
 * left the transcript in place but wrote subagents under the worktree folder.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'
import { AgentEvent, WatchedSession } from '../src/protocol'
import { SubagentWatcherDelegate, scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import { findSessionTranscript, findSubagentsDirs, followSession } from '../src/session-relocation'

const SESSION_ID = '76a13aaf-fb69-49bf-8e0f-98e04e8c7f4d'
const REPO = '-repo'
const WORKTREE = '-repo--claude-worktrees-repro-wt'

function makeSession(filePath: string): WatchedSession {
  return {
    sessionId: SESSION_ID,
    filePath,
    fileWatcher: null,
    pollTimer: null,
    fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: true,
    sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(path.dirname(filePath), SESSION_ID, 'subagents'),
    label: 'Session',
    labelSet: true,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null,
    permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

function toolUse(id: string): string {
  return JSON.stringify({
    type: 'assistant', uuid: `a-${id}`,
    message: { role: 'assistant', model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id, name: 'Read', input: { file_path: '/repo/a.txt' } },
    ] },
  }) + '\n'
}

let root: string
let session: WatchedSession
let events: AgentEvent[]
let delegate: SubagentWatcherDelegate & TranscriptParserDelegate
let parser: TranscriptParser

function write(rel: string, content: string) {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-relocation-'))
  events = []
  session = makeSession(path.join(root, REPO, `${SESSION_ID}.jsonl`))
  delegate = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getLastActivityTime: () => Date.now(),
    getSession: (id) => (id === SESSION_ID ? session : undefined),
    resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  parser = new TranscriptParser(delegate)
})

afterEach(() => {
  session.subagentsDirWatcher?.close()
  for (const state of session.subagentWatchers.values()) {
    state.watcher?.close()
    if (state.permissionTimer) clearTimeout(state.permissionTimer)
  }
  if (session.permissionTimer) clearTimeout(session.permissionTimer)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findSessionTranscript', () => {
  it('finds the transcript in whichever project folder holds it', () => {
    const moved = write(`${WORKTREE}/${SESSION_ID}.jsonl`, '')
    write(`${WORKTREE}/${SESSION_ID}/subagents/agent-a1.jsonl`, '')
    assert.equal(findSessionTranscript(root, SESSION_ID), moved)
  })

  it('prefers the most recently written copy', () => {
    const older = write(`${REPO}/${SESSION_ID}.jsonl`, '')
    const newer = write(`${WORKTREE}/${SESSION_ID}.jsonl`, '')
    fs.utimesSync(older, new Date(1000), new Date(1000))
    assert.equal(findSessionTranscript(root, SESSION_ID), newer)
  })

  it('returns null when no folder has it, or the root is missing', () => {
    write(`${REPO}/other-session.jsonl`, '')
    assert.equal(findSessionTranscript(root, SESSION_ID), null)
    assert.equal(findSessionTranscript(path.join(root, 'missing'), SESSION_ID), null)
  })
})

describe('findSubagentsDirs', () => {
  it('lists the session subagent folders across project folders', () => {
    write(`${REPO}/${SESSION_ID}/subagents/agent-a1.jsonl`, '')
    write(`${WORKTREE}/${SESSION_ID}/subagents/agent-a2.jsonl`, '')
    write(`${WORKTREE}/other-session/subagents/agent-a3.jsonl`, '')
    assert.deepEqual(findSubagentsDirs(root, SESSION_ID).sort(), [
      path.join(root, REPO, SESSION_ID, 'subagents'),
      path.join(root, WORKTREE, SESSION_ID, 'subagents'),
    ].sort())
  })
})

describe('followSession', () => {
  it('re-points a session whose transcript moved into a worktree folder, keeping offsets', () => {
    write(`${REPO}/${SESSION_ID}.jsonl`, '{"type":"user"}\n')
    const oldSub = write(`${REPO}/${SESSION_ID}/subagents/agent-a1.jsonl`, toolUse('t1'))
    scanSubagentsDir(delegate, parser, SESSION_ID)
    const offset = session.subagentWatchers.get(oldSub)!.fileSize
    assert.ok(offset > 0)

    // What EnterWorktree does: move the transcript and the session folder
    fs.mkdirSync(path.join(root, WORKTREE))
    fs.renameSync(path.join(root, REPO, `${SESSION_ID}.jsonl`), path.join(root, WORKTREE, `${SESSION_ID}.jsonl`))
    fs.renameSync(path.join(root, REPO, SESSION_ID), path.join(root, WORKTREE, SESSION_ID))

    assert.equal(followSession(delegate, parser, session, root), true)
    const newSub = path.join(root, WORKTREE, SESSION_ID, 'subagents', 'agent-a1.jsonl')
    assert.equal(session.filePath, path.join(root, WORKTREE, `${SESSION_ID}.jsonl`))
    assert.equal(session.subagentsDir, path.join(root, WORKTREE, SESSION_ID, 'subagents'))
    assert.deepEqual([...session.subagentWatchers.keys()], [newSub])
    assert.equal(session.subagentWatchers.get(newSub)!.fileSize, offset)

    // New subagent activity after the move is read from where it left off
    fs.appendFileSync(newSub, toolUse('t2'))
    events.length = 0
    readSubagentNewLines(delegate, parser, newSub, SESSION_ID)
    const starts = events.filter(e => e.type === 'tool_call_start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].payload.agent, session.subagentWatchers.get(newSub)!.agentName)
  })

  it('leaves a session alone when its transcript has not moved', () => {
    write(`${REPO}/${SESSION_ID}.jsonl`, '')
    const before = session.filePath
    assert.equal(followSession(delegate, parser, session, root), false)
    assert.equal(session.filePath, before)
  })

  it('watches subagents written under a worktree folder while the transcript stays put', () => {
    write(`${REPO}/${SESSION_ID}.jsonl`, '')
    const split = write(`${WORKTREE}/${SESSION_ID}/subagents/agent-a9.jsonl`, toolUse('t9'))

    assert.equal(followSession(delegate, parser, session, root), false)
    assert.ok(session.subagentWatchers.has(split))
    assert.ok(events.some(e => e.type === 'agent_spawn'), 'active subagent is spawned')
  })
})
