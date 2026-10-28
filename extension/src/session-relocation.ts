/**
 * Following a Claude Code session across project folders.
 *
 * Transcripts live under `~/.claude/projects/<encoded cwd>/`. When a session
 * enters a git worktree mid-session (EnterWorktree), Claude Code moves
 * `<sessionId>.jsonl` and its `<sessionId>/` folder into the worktree's project
 * folder and logs a `relocated` entry. Older versions left the transcript in
 * place but wrote subagent transcripts under the worktree's folder. Either way,
 * a watcher that keeps the path it started with stops seeing the session.
 *
 * Kept free of `vscode` so the relay and tests can use it.
 */

import * as fs from 'fs'
import * as path from 'path'
import { WatchedSession } from './protocol'
import { TranscriptParser } from './transcript-parser'
import { SubagentWatcherDelegate, moveSubagentWatchers, scanExtraSubagentDirs } from './subagent-watcher'

function projectDirs(projectsRoot: string): string[] {
  try {
    return fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projectsRoot, d.name))
  } catch { return [] }
}

/** The newest `<sessionId>.jsonl` directly under any project folder, or null. */
export function findSessionTranscript(projectsRoot: string, sessionId: string): string | null {
  let best: string | null = null
  let bestMtime = -1
  for (const dir of projectDirs(projectsRoot)) {
    const candidate = path.join(dir, `${sessionId}.jsonl`)
    try {
      const mtime = fs.statSync(candidate).mtimeMs
      if (mtime > bestMtime) { best = candidate; bestMtime = mtime }
    } catch { /* not in this folder */ }
  }
  return best
}

/** Every `<project>/<sessionId>/subagents` folder that exists. */
export function findSubagentsDirs(projectsRoot: string, sessionId: string): string[] {
  return projectDirs(projectsRoot)
    .map(dir => path.join(dir, sessionId, 'subagents'))
    .filter(dir => fs.existsSync(dir))
}

/**
 * Catch up with a session that moved to another project folder. Call it from
 * the poll loop.
 *
 * If the transcript is gone from `session.filePath`, re-points the session (and
 * its subagent watchers) at where it now lives, keeping read offsets, and
 * returns true so the caller can re-attach its file watcher. Also starts
 * watching subagent folders for this session under other project folders.
 */
export function followSession(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  session: WatchedSession,
  projectsRoot: string,
): boolean {
  let moved = false
  if (!fs.existsSync(session.filePath)) {
    const found = findSessionTranscript(projectsRoot, session.sessionId)
    if (found && found !== session.filePath) {
      const oldSubagentsDir = session.subagentsDir
      const newSubagentsDir = path.join(path.dirname(found), session.sessionId, 'subagents')
      session.filePath = found
      session.subagentsDirWatcher?.close()
      session.subagentsDirWatcher = null
      session.subagentsDir = newSubagentsDir
      if (oldSubagentsDir) {
        moveSubagentWatchers(delegate, parser, session.sessionId, oldSubagentsDir, newSubagentsDir)
      }
      moved = true
    }
  }

  const extra = findSubagentsDirs(projectsRoot, session.sessionId).filter(d => d !== session.subagentsDir)
  if (extra.length > 0) {
    scanExtraSubagentDirs(delegate, parser, session.sessionId, extra)
  }
  return moved
}
