import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawnSync } from 'child_process'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import { handlePermissionDetection, type PermissionState } from './permission-detection'
import {
  CodexRolloutParser, CodexRolloutState,
  createCodexRolloutState, extractCodexTimestampMs,
} from './codex-rollout-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'

const log = createLogger('CodexSessionWatcher')

interface CodexThreadDescriptor {
  id: string
  label: string
  filePath: string
  cwd?: string
  model?: string | null
}

interface WatchedCodexSession extends PermissionState {
  sessionId: string
  filePath: string
  label: string
  model: string | null
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  rolloutState: CodexRolloutState
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function parseJsonLines<T>(text: string): T[] {
  const rows: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed) as T)
    } catch {
      // Ignore malformed rows — discovery should be resilient
    }
  }
  return rows
}

function findNewestFile(directory: string, pattern: RegExp): string | null {
  if (!fs.existsSync(directory)) return null
  let newestPath: string | null = null
  let newestMtime = -1
  for (const entry of fs.readdirSync(directory)) {
    if (!pattern.test(entry)) continue
    const filePath = path.join(directory, entry)
    const mtime = fs.statSync(filePath).mtimeMs
    if (mtime > newestMtime) {
      newestPath = filePath
      newestMtime = mtime
    }
  }
  return newestPath
}

function extractSessionIdFromRolloutPath(filePath: string): string | null {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match?.[1] ?? null
}

function collectJsonlFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const results: string[] = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath)
      }
    }
  }
  return results
}

export class CodexSessionWatcher implements AgentSessionWatcher {
  private readonly codexHome: string
  private readonly stateDbPath: string | null
  private readonly sessionIndexPath: string
  private readonly sessions = new Map<string, WatchedCodexSession>()
  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<SessionLifecycleEvent>()
  private scanInterval: NodeJS.Timeout | null = null
  private workspacePath: string | null = null

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  constructor() {
    this.codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const sqliteHome = process.env.CODEX_SQLITE_HOME || this.codexHome
    this.stateDbPath = findNewestFile(sqliteHome, /^state.*\.sqlite$/)
    this.sessionIndexPath = path.join(this.codexHome, 'session_index.jsonl')
  }

  start(): void {
    this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
    log.info(`Starting — workspace: ${this.workspacePath || 'all projects'}`)
    this.scanForActiveSessions()
    this.scanInterval = setInterval(() => {
      this.scanForActiveSessions()
    }, SCAN_INTERVAL_MS)
  }

  isActive(): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionDetected) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.sessionDetected
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.sessionId,
      label: session.label,
      status: session.sessionCompleted ? 'completed' : 'active',
      startTime: session.sessionStartTime,
      lastActivityTime: session.lastActivityTime,
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const [sessionId, session] of this.sessions) {
      if (!session.sessionDetected) continue
      if (sessionIds && !sessionIds.includes(sessionId)) continue
      this.emit({
        time: 0,
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME,
          isMain: true,
          task: session.label,
          ...(session.model ? { model: session.model } : {}),
        },
      }, sessionId)
      this._onSessionDetected.fire(sessionId)
    }
  }

  private scanForActiveSessions(): void {
    const threads = this.discoverThreads()
    const activeThreads = threads.filter((thread) => {
      try {
        const ageSeconds = (Date.now() - fs.statSync(thread.filePath).mtimeMs) / 1000
        return ageSeconds <= ACTIVE_SESSION_AGE_S
      } catch {
        return false
      }
    })

    for (const thread of activeThreads) {
      const existing = this.sessions.get(thread.id)
      if (!existing) {
        log.info(`Active Codex session found: ${thread.filePath}`)
        this.watchSession(thread)
      } else if (existing.label !== thread.label) {
        existing.label = thread.label
        this._onSessionLifecycle.fire({ type: 'updated', sessionId: thread.id, label: thread.label })
      }
    }
  }

  private discoverThreads(): CodexThreadDescriptor[] {
    const dbThreads = this.queryThreadsFromStateDb()
    if (dbThreads.length > 0) return dbThreads
    return this.queryThreadsFromSessionIndex()
  }

  private queryThreadsFromStateDb(): CodexThreadDescriptor[] {
    if (!this.stateDbPath || !fs.existsSync(this.stateDbPath)) return []

    const cwdFilter = this.workspacePath ? ` AND cwd = ${sqlQuote(this.workspacePath)}` : ''
    const sql = `
      SELECT json_object(
        'id', id,
        'label', COALESCE(NULLIF(title, ''), NULLIF(first_user_message, ''), 'Session ' || substr(id, 1, 8)),
        'rollout_path', rollout_path,
        'cwd', cwd,
        'model', model
      )
      FROM threads
      WHERE rollout_path IS NOT NULL
        AND COALESCE(agent_role, '') = ''
        ${cwdFilter}
      ORDER BY updated_at DESC
      LIMIT 200;
    `

    const result = spawnSync('sqlite3', [this.stateDbPath, sql], { encoding: 'utf8' })
    if (result.status !== 0) {
      log.warn('Failed to query Codex state DB, falling back to session index')
      return []
    }

    return parseJsonLines<Record<string, unknown>>(result.stdout)
      .map((row) => ({
        id: String(row.id || ''),
        label: String(row.label || '').trim() || `Session ${String(row.id || '').slice(0, SESSION_ID_DISPLAY)}`,
        filePath: String(row.rollout_path || ''),
        cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
        model: typeof row.model === 'string' ? row.model : null,
      }))
      .filter((thread) => thread.id && thread.filePath && fs.existsSync(thread.filePath))
  }

  private queryThreadsFromSessionIndex(): CodexThreadDescriptor[] {
    if (!fs.existsSync(this.sessionIndexPath)) return []

    const indexEntries = parseJsonLines<Record<string, unknown>>(fs.readFileSync(this.sessionIndexPath, 'utf8'))
    const labels = new Map<string, string>()
    for (const entry of indexEntries) {
      const id = typeof entry.id === 'string' ? entry.id : undefined
      const label = typeof entry.thread_name === 'string' ? entry.thread_name : undefined
      if (id) labels.set(id, label || `Session ${id.slice(0, SESSION_ID_DISPLAY)}`)
    }

    const sessionDir = path.join(this.codexHome, 'sessions')
    const threads: CodexThreadDescriptor[] = []
    for (const filePath of collectJsonlFiles(sessionDir)) {
      const id = extractSessionIdFromRolloutPath(filePath)
      if (!id) continue
      threads.push({
        id,
        label: labels.get(id) || `Session ${id.slice(0, SESSION_ID_DISPLAY)}`,
        filePath,
        model: null,
      })
    }
    return threads
  }

  private watchSession(thread: CodexThreadDescriptor): void {
    const stat = fs.statSync(thread.filePath)
    const existingContent = fs.readFileSync(thread.filePath, 'utf8')
    const lines = existingContent.split('\n').filter(Boolean)
    const firstTimestamp = lines.map(extractCodexTimestampMs).find((value): value is number => value !== null)
    const sessionStartTime = firstTimestamp ?? stat.mtimeMs

    const session: WatchedCodexSession = {
      sessionId: thread.id,
      filePath: thread.filePath,
      label: thread.label,
      model: thread.model ?? null,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: stat.size,
      sessionStartTime,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: true,
      sessionCompleted: false,
      rolloutState: createCodexRolloutState(),
      permissionTimer: null,
      permissionEmitted: false,
    }
    this.sessions.set(thread.id, session)

    this._onSessionDetected.fire(thread.id)
    this._onSessionLifecycle.fire({ type: 'started', sessionId: thread.id, label: thread.label })

    this.emit({
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME,
        isMain: true,
        task: thread.label,
        ...(thread.model ? { model: thread.model } : {}),
      },
    }, thread.id)

    const parser = new CodexRolloutParser(
      { emit: (event) => this.emit(event, thread.id) },
      thread.id,
      session.sessionStartTime,
      session.rolloutState,
    )
    for (const line of lines) {
      parser.processLine(line)
    }

    session.fileWatcher = fs.watch(thread.filePath, (eventType) => {
      if (eventType === 'change') {
        this.readNewLines(thread.id)
      }
    })

    session.pollTimer = setInterval(() => {
      this.readNewLines(thread.id)
    }, POLL_FALLBACK_MS)

    this.resetInactivityTimer(thread.id)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const result = readNewFileLines(session.filePath, session.fileSize)
    if (!result) return

    session.fileSize = result.newSize
    session.lastActivityTime = Date.now()

    const parser = new CodexRolloutParser(
      { emit: (event) => this.emit(event, sessionId) },
      sessionId,
      session.sessionStartTime,
      session.rolloutState,
    )

    for (const line of result.lines) {
      parser.processLine(line)
    }

    handlePermissionDetection(
      {
        emit: (event, sid) => this.emit(event, sid),
        elapsed: (sid) => this.elapsed(sid),
        getLastActivityTime: (sid) => this.sessions.get(sid)?.lastActivityTime,
      },
      ORCHESTRATOR_NAME,
      session.rolloutState.permissionPendingToolCalls,
      session,
      sessionId,
      session.sessionCompleted,
      true,
    )

    this.resetInactivityTimer(sessionId)
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const wasCompleted = session.sessionCompleted
    session.lastActivityTime = Date.now()
    session.sessionCompleted = false

    if (wasCompleted) {
      this.emit({
        time: this.elapsed(sessionId),
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME,
          isMain: true,
          task: session.label,
          ...(session.model ? { model: session.model } : {}),
        },
      }, sessionId)
      this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })
    }

    if (session.inactivityTimer) {
      clearTimeout(session.inactivityTimer)
    }

    session.inactivityTimer = setTimeout(() => {
      if (!session.sessionCompleted && session.sessionDetected) {
        log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive — emitting completion`)
        session.sessionCompleted = true
        this.emit({
          time: this.elapsed(sessionId),
          type: 'agent_complete',
          payload: { name: ORCHESTRATOR_NAME },
        }, sessionId)
        this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: session.label })
      }
    }, INACTIVITY_TIMEOUT_MS)
  }

  private elapsed(sessionId?: string): number {
    if (!sessionId) return 0
    const session = this.sessions.get(sessionId)
    if (!session) return 0
    return (Date.now() - session.sessionStartTime) / 1000
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this._onEvent.fire(sessionId ? { ...event, sessionId } : event)
  }

  dispose(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    for (const session of this.sessions.values()) {
      session.fileWatcher?.close()
      if (session.pollTimer) clearInterval(session.pollTimer)
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
      if (session.permissionTimer) clearTimeout(session.permissionTimer)
    }
    this.sessions.clear()

    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
