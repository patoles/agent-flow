/**
 * Watches Strands agent-flow JSONL files at ~/.strands/agent-flow/<session-id>.jsonl
 *
 * The Strands AgentFlowHookProvider writes one JSONL file per agent session.
 * Each line is a complete AgentEvent in agent-flow's native schema, so no
 * parser/translation layer is needed — just JSON.parse + validate.
 *
 * Discovery scans the agent-flow directory for recent .jsonl files, optionally
 * filtering by workspace cwd (read from the first agent_spawn payload).
 * Respects STRANDS_HOME for non-default installs.
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
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('StrandsSessionWatcher')

/** Extract session ID from filename: <uuid>.jsonl */
const SESSION_ID_FROM_FILENAME = /^([0-9a-f-]{36})\.jsonl$/

interface WatchedStrandsSession {
  sessionId: string
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
}

function strandsHome(): string {
  return process.env.STRANDS_HOME || path.join(os.homedir(), '.strands')
}

function agentFlowDir(): string {
  return path.join(strandsHome(), 'agent-flow')
}

/** Read the first line of a session file to extract cwd from agent_spawn payload. */
function readSessionCwd(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      const firstNewline = buf.subarray(0, read).indexOf(0x0a)
      const end = firstNewline >= 0 ? firstNewline : read
      const line = buf.slice(0, end).toString('utf-8')
      const parsed = JSON.parse(line) as { type?: string; payload?: { cwd?: string } }
      if (parsed.type !== 'agent_spawn') return null
      return typeof parsed.payload?.cwd === 'string' ? parsed.payload.cwd : null
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

export class StrandsSessionWatcher implements AgentSessionWatcher {
  private dirWatcher: fs.FSWatcher | null = null
  private sessions = new Map<string, WatchedStrandsSession>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

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

    const dir = agentFlowDir()
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }) }
      catch (err) { log.debug('Failed to create agent-flow dir:', err) }
    }

    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    if (fs.existsSync(dir)) {
      try {
        this.dirWatcher = fs.watch(dir, () => this.scanForSessions())
      } catch (err) { log.debug('Dir watch failed:', err) }
    }

    log.info(`Watching ${dir} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private scanForSessions(): void {
    const dir = agentFlowDir()
    if (!fs.existsSync(dir)) return

    let entries: string[]
    try { entries = fs.readdirSync(dir) }
    catch { return }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const m = name.match(SESSION_ID_FROM_FILENAME)
      const sessionId = m ? m[1] : name.replace('.jsonl', '')
      if (this.sessions.has(sessionId)) continue

      const filePath = path.join(dir, name)

      let stat: fs.Stats
      try { stat = fs.statSync(filePath) } catch { continue }
      if (stat.size === 0) continue
      const ageS = (Date.now() - stat.mtimeMs) / 1000
      if (ageS > ACTIVE_SESSION_AGE_S) continue

      if (this.workspacePath) {
        const cwd = readSessionCwd(filePath)
        if (cwd !== null) {
          const resolvedCwd = this.resolvePath(cwd)
          if (resolvedCwd && !this.pathMatchesWorkspace(resolvedCwd)) continue
        }
      }

      this.attachSession(sessionId, filePath, stat)
    }
  }

  private resolvePath(p: string): string | null {
    try { return fs.realpathSync(p) } catch { return p }
  }

  private pathMatchesWorkspace(p: string): boolean {
    if (!this.workspacePath) return true
    if (p === this.workspacePath) return true
    return p.startsWith(this.workspacePath + path.sep)
  }

  private attachSession(sessionId: string, filePath: string, stat: fs.Stats): void {
    const label = `Strands ${sessionId.slice(0, SESSION_ID_DISPLAY)}`

    const session: WatchedStrandsSession = {
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
    }
    this.sessions.set(sessionId, session)

    this.readNewLines(sessionId)

    session.sessionDetected = true
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label })

    try {
      session.fileWatcher = fs.watch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

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

    if (session.sessionCompleted) {
      session.sessionCompleted = false
      this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })
      log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} re-activated after idle`)
    }

    for (const line of result.lines) {
      const event = this.parseLine(line)
      if (!event) continue
      this._onEvent.fire({ ...event, sessionId })

      // Update label from first user message
      if (event.type === 'message' && event.payload?.role === 'user' && session.label.startsWith('Strands ')) {
        const content = String(event.payload.content || '').slice(0, 40)
        if (content) {
          session.label = content
          this._onSessionLifecycle.fire({ type: 'updated', sessionId, label: content })
        }
      }
    }

    this.resetInactivityTimer(sessionId)
  }

  private parseLine(line: string): AgentEvent | null {
    try {
      const parsed = JSON.parse(line.trim())
      if (parsed && typeof parsed.type === 'string' && typeof parsed.time === 'number') {
        return parsed as AgentEvent
      }
      return null
    } catch { return null }
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
    this.dirWatcher?.close()
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
