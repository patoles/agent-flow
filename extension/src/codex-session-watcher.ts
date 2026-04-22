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
import { TypedEventEmitter } from './typed-event-emitter'

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
  /** Leftover bytes past the last newline from the previous read — prepended
   *  to the next chunk so a JSONL line split across reads gets reassembled. */
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  rolloutState: CodexRolloutState
  parser: CodexRolloutParser
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

/** Walk the past SCAN_DAYS of sessions/YYYY/MM/DD directories relative to `now`.
 *  Codex's CLI partitioning can use either local or UTC dates depending on the
 *  platform; yield both to be safe. The 3-day window + dedup-via-Set makes this
 *  trivially cheap. */
function recentSessionDirs(now: Date): string[] {
  const root = sessionsRoot()
  const seen = new Set<string>()
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    for (const [y, m, day] of [
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
    ]) {
      const dir = path.join(root,
        String(y),
        String(m).padStart(2, '0'),
        String(day).padStart(2, '0'))
      if (!seen.has(dir)) seen.add(dir)
    }
  }
  return Array.from(seen)
}

/** Read the first line of a rollout file to extract cwd from session_meta.
 *
 *  UTF-8 safety: `\n` is 0x0a, which never appears as a continuation byte in
 *  a multi-byte UTF-8 sequence (continuation bytes are 0x80–0xBF), so slicing
 *  at the byte-indexed newline is guaranteed to land on a character boundary.
 *  If no newline is found in the first 64KB (pathological session_meta), we
 *  fall back to the full read — JSON.parse will fail on the truncated object
 *  and we'll return null rather than emit a corrupted cwd. */
function readSessionCwd(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      // First line is session_meta; it's typically well under 4KB, but
      // base_instructions can push it larger. Read a generous chunk.
      const buf = Buffer.alloc(65536)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      // indexOf bounded to the filled portion — unwritten bytes are zero and
      // would never match 0x0a, but an explicit end offset makes this obvious.
      const firstNewline = buf.subarray(0, read).indexOf(0x0a)
      const end = firstNewline >= 0 ? firstNewline : read
      const line = buf.slice(0, end).toString('utf-8')
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

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a cwd filter — Codex sessions are attached only if
   *  their session_meta.cwd matches this path (or is under it). Pass null/undefined
   *  to attach to any Codex session (useful when no workspace is open). */
  constructor(private readonly workspace?: string | null) {}

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
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
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
    const label = `Codex ${sessionId.slice(0, SESSION_ID_DISPLAY)}`

    // Build the parser once per session so the delegate closures capture the
    // right session reference and re-emission is stateless on this side.
    const parser = new CodexRolloutParser({
      emit: (event) => this._onEvent.fire({ ...event, sessionId }),
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        if (!s || !s.label.startsWith('Codex ')) return // only replace auto-label
        s.label = newLabel
        this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: newLabel })
      },
    })

    const session: WatchedCodexSession = {
      sessionId,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: false,
      label,
      rolloutState: createCodexRolloutState(),
      parser,
    }
    this.sessions.set(sessionId, session)

    // Drain existing content first, so late-opening panels see full history.
    this.readNewLines(sessionId)

    session.sessionDetected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label })

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

    const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
    if (!result) return
    session.fileSize = result.newSize
    session.fileTail = result.tail
    session.lastActivityTime = Date.now()

    // Re-activate if the session had been marked complete on inactivity —
    // new content means the user resumed the Codex CLI.
    if (session.sessionCompleted) {
      session.sessionCompleted = false
      this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })
      log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} re-activated after idle`)
    }

    for (const line of result.lines) {
      try { session.parser.processLine(line, session.rolloutState) }
      catch (err) { log.debug('Parser threw on line:', err) }
    }

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
