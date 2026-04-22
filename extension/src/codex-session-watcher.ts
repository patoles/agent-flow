/**
 * Watches Codex rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex writes one JSONL file per session. Each file begins with a session_meta
 * record carrying the cwd, from which we match against the active VS Code
 * workspace. Discovery scans the past few days of session directories (to catch
 * sessions started near midnight), filters by cwd match and recency, and tails
 * matching files.
 *
 * No SQLite dependency — the canonical source is the filesystem. Respects
 * CODEX_HOME for non-default installs.
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import {
  CodexRolloutParser, CodexRolloutState, createCodexRolloutState,
} from './codex-rollout-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'

const log = createLogger('CodexSessionWatcher')

/** Number of past YYYY/MM/DD directories to scan during discovery.
 *  3 covers sessions near midnight + timezone-drift. */
const SCAN_DAYS = 3

/** Extract the session UUID from a rollout filename.
 *  Filenames look like: rollout-2026-04-22T09-15-00-{uuid}.jsonl */
const SESSION_ID_FROM_FILENAME = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/

interface WatchedCodexSession {
  sessionId: string
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  model: string | null
  cwd: string | null
  rolloutState: CodexRolloutState
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

/** Walk the past SCAN_DAYS of sessions/YYYY/MM/DD directories relative to `now`. */
function* recentSessionDirs(now: Date): Iterable<string> {
  const root = sessionsRoot()
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const y = d.getUTCFullYear().toString()
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
    const day = d.getUTCDate().toString().padStart(2, '0')
    yield path.join(root, y, m, day)
  }
}

/** Read the first line of a rollout file to extract cwd from session_meta. */
function readSessionCwd(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      // First line is session_meta; it's typically well under 4KB, but base_instructions
      // can push it larger. Read a generous chunk.
      const buf = Buffer.alloc(65536)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      const firstNewline = buf.indexOf(0x0a, 0)
      const line = buf.slice(0, firstNewline > 0 ? firstNewline : read).toString('utf-8')
      const parsed = JSON.parse(line) as { type?: string; payload?: { cwd?: string } }
      if (parsed.type !== 'session_meta') return null
      return typeof parsed.payload?.cwd === 'string' ? parsed.payload.cwd : null
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class CodexSessionWatcher implements AgentSessionWatcher {
  private dirWatchers = new Map<string, fs.FSWatcher>()
  private sessions = new Map<string, WatchedCodexSession>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected && !s.sessionCompleted) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected && !s.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      status: s.sessionCompleted ? 'completed' : 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [id, session] of this.sessions) {
      if (!session.sessionDetected) continue
      if (sessionIds && !sessionIds.includes(id)) continue
      this._onSessionLifecycle.fire({ type: 'started', sessionId: id, label: session.label })
    }
  }

  start(): void {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspace) {
      try { this.workspacePath = fs.realpathSync(workspace) }
      catch { this.workspacePath = workspace }
    }

    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    // Watch the sessions root for new day directories appearing.
    const root = sessionsRoot()
    if (fs.existsSync(root)) {
      try {
        const rootWatcher = fs.watch(root, { recursive: false }, () => this.scanForSessions())
        this.dirWatchers.set(root, rootWatcher)
      } catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private scanForSessions(): void {
    const now = new Date()
    for (const dir of recentSessionDirs(now)) {
      if (!fs.existsSync(dir)) continue

      // Watch this day's directory so we pick up new rollout files quickly
      if (!this.dirWatchers.has(dir)) {
        try {
          const w = fs.watch(dir, () => this.scanForSessions())
          this.dirWatchers.set(dir, w)
        } catch (err) { log.debug('Dir watch failed:', dir, err) }
      }

      let entries: string[]
      try { entries = fs.readdirSync(dir) }
      catch { continue }

      for (const name of entries) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const filePath = path.join(dir, name)
        if (this.sessions.has(this.sessionIdFor(filePath))) continue

        // Recency filter — skip stale files
        let stat: fs.Stats
        try { stat = fs.statSync(filePath) } catch { continue }
        if (stat.size === 0) continue
        const ageS = (Date.now() - stat.mtimeMs) / 1000
        if (ageS > ACTIVE_SESSION_AGE_S) continue

        // Workspace filter — only attach if cwd matches (or no workspace set)
        if (this.workspacePath) {
          const cwd = readSessionCwd(filePath)
          if (cwd === null) continue
          const resolvedCwd = this.resolvePath(cwd)
          if (!resolvedCwd || !this.pathMatchesWorkspace(resolvedCwd)) continue
        }

        this.attachSession(filePath, stat)
      }
    }
  }

  private sessionIdFor(filePath: string): string {
    const m = path.basename(filePath).match(SESSION_ID_FROM_FILENAME)
    return m ? m[1] : path.basename(filePath, '.jsonl')
  }

  private resolvePath(p: string): string | null {
    try { return fs.realpathSync(p) } catch { return p }
  }

  private pathMatchesWorkspace(p: string): boolean {
    if (!this.workspacePath) return true
    if (p === this.workspacePath) return true
    return p.startsWith(this.workspacePath + path.sep)
  }

  private attachSession(filePath: string, stat: fs.Stats): void {
    const sessionId = this.sessionIdFor(filePath)

    const session: WatchedCodexSession = {
      sessionId,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: false,
      label: `Codex ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      model: null,
      cwd: null,
      rolloutState: createCodexRolloutState(),
    }
    this.sessions.set(sessionId, session)

    // Drain existing content first, so late-opening panels see full history.
    this.readNewLines(sessionId)

    session.sessionDetected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })

    try {
      session.fileWatcher = fs.watch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

    // fs.watch on macOS sometimes silently stops after long idle — poll as backup.
    session.pollTimer = setInterval(() => this.readNewLines(sessionId), POLL_FALLBACK_MS)

    this.resetInactivityTimer(sessionId)
    log.info(`Attached to session ${sessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const result = readNewFileLines(session.filePath, session.fileSize)
    if (!result) return
    session.fileSize = result.newSize
    session.lastActivityTime = Date.now()

    const parser = new CodexRolloutParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => (Date.now() - session.sessionStartTime) / 1000,
      setLabel: (label) => {
        if (session.label.startsWith('Codex ')) { // only replace auto-label
          session.label = label
          this._onSessionLifecycle.fire({ type: 'updated', sessionId, label })
        }
      },
    })

    for (const line of result.lines) {
      try { parser.processLine(line, session.rolloutState) }
      catch (err) { log.debug('Parser threw on line:', err) }
    }

    // Pull updated model/cwd out of state
    session.model = session.rolloutState.model
    session.cwd = session.rolloutState.cwd

    this.resetInactivityTimer(sessionId)
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
    session.inactivityTimer = setTimeout(() => {
      if (session.sessionCompleted) return
      session.sessionCompleted = true
      this._onEvent.fire({
        time: (Date.now() - session.sessionStartTime) / 1000,
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
        sessionId,
      })
      this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: session.label })
    }, INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
    }
    this.sessions.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
