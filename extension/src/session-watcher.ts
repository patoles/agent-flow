import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo, WatchedSession } from './protocol'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
} from './constants'
import { TranscriptParser } from './transcript-parser'
import { readNewFileLines } from './fs-utils'
import { handlePermissionDetection } from './permission-detection'
import { scanSubagentsDir, readSubagentNewLines } from './subagent-watcher'
import { createLogger } from './logger'

const log = createLogger('SessionWatcher')

/**
 * Watches Claude Code JSONL session transcript files for activity.
 *
 * Supports multiple concurrent sessions — each gets its own WatchedSession
 * with independent state for tool call tracking, dedup, and subagent watchers.
 *
 * Claude Code writes full conversation transcripts to:
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Each line is a JSON object with:
 *   { sessionId, type, message: { role: "assistant"|"user", content: [...] } }
 *
 * Assistant messages contain tool_use blocks: { type: "tool_use", name, id, input }
 * User messages contain tool_result blocks:   { type: "tool_result", tool_use_id, content }
 *
 * We parse these to emit AgentEvent objects for the visualizer.
 */

// WatchedSession and SubagentState are defined in protocol.ts and re-exported here for convenience
export type { WatchedSession, SubagentState } from './protocol'

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

export class SessionWatcher implements vscode.Disposable {
  private dirWatcher: fs.FSWatcher | null = null
  private dirWatchers = new Map<string, fs.FSWatcher>()
  private sessions = new Map<string, WatchedSession>()
  private workspacePath: string | null = null
  /** Resolved absolute workspace path for subdirectory verification */
  private resolvedWorkspace: string | null = null
  /** Cache for isContainedProject results — avoids re-reading JSONL files every scan */
  private containedProjectCache = new Map<string, boolean>()
  private scanInterval: NodeJS.Timeout | null = null

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<{ type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }>()

  private readonly parser: TranscriptParser = new TranscriptParser({
    emit: (event, sessionId) => this.emit(event, sessionId),
    elapsed: (sessionId) => this.elapsed(sessionId),
    getSession: (sessionId) => this.sessions.get(sessionId),
    fireSessionLifecycle: (event) => this._onSessionLifecycle.fire(event),
    emitContextUpdate: (agentName, session, sessionId) => this.emitContextUpdate(agentName, session, sessionId),
  })

  /** Delegate for subagent/permission modules to call back into this watcher */
  private readonly selfDelegate = {
    emit: (event: AgentEvent, sessionId?: string) => this.emit(event, sessionId),
    elapsed: (sessionId?: string) => this.elapsed(sessionId),
    getSession: (sessionId: string) => this.sessions.get(sessionId),
    getLastActivityTime: (sessionId: string) => this.sessions.get(sessionId)?.lastActivityTime,
    resetInactivityTimer: (sessionId: string) => this.resetInactivityTimer(sessionId),
  }

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Whether any session is actively being tailed */
  isActive(): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionDetected) return true
    }
    return false
  }

  /** Whether a specific session is active */
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.sessionDetected
  }

  /** Get list of currently tracked sessions */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.sessionId,
      label: s.label,
      status: s.sessionCompleted ? 'completed' : 'active',
      startTime: s.sessionStartTime,
      lastActivityTime: s.lastActivityTime,
    }))
  }

  /** Re-emit session start + conversation events for a newly connected webview.
   *  If sessionIds is provided, only replay those sessions. */
  replaySessionStart(sessionIds?: string[]): void {
    for (const [sessionId, session] of this.sessions) {
      if (!session.sessionDetected) { continue }
      if (sessionIds && !sessionIds.includes(sessionId)) { continue }
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

      for (const [, sub] of session.subagentWatchers) {
        sub.spawnEmitted = false
      }

      this._onSessionDetected.fire(sessionId)
    }
  }

  start(): void {
    // Scope to the current workspace so we only watch sessions for this project
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspaceFolder) {
      // Claude Code encodes project paths: /Users/simon/my_project → -Users-simon-my-project
      // Resolve symlinks first, then replace /, \, : (drive letter), and _ with -
      let resolved = workspaceFolder
      try { resolved = fs.realpathSync(resolved) } catch { /* use original if realpathSync fails */ }
      const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')

      this.resolvedWorkspace = resolved

      // Try the resolved encoding first; fall back to unresolved if the directory doesn't exist
      // (handles edge cases where Claude Code didn't resolve symlinks the same way)
      const resolvedDir = path.join(CLAUDE_DIR, encoded)
      if (fs.existsSync(resolvedDir)) {
        this.workspacePath = encoded
      } else {
        const unresolvedEncoded = workspaceFolder.replace(/[^a-zA-Z0-9]/g, '-')
        const unresolvedDir = path.join(CLAUDE_DIR, unresolvedEncoded)
        this.workspacePath = fs.existsSync(unresolvedDir) ? unresolvedEncoded : encoded
      }
      log.info(`Starting — scoped to project: ${this.workspacePath}`)
    } else {
      log.info('Starting — no workspace, scanning all projects')
    }

    this.scanForActiveSessions()

    // Watch project directories for instant new-file detection.
    // Watch both the exact workspace dir and the parent CLAUDE_DIR (to detect
    // new subdirectory project dirs, e.g. CLI sessions started from a subfolder).
    this.watchProjectDirs()

    // Re-scan periodically as fallback (1s instead of 3s for faster detection)
    this.scanInterval = setInterval(() => {
      this.scanForActiveSessions()
    }, SCAN_INTERVAL_MS)
  }

  /** Set up fs.watch on known project directories and the parent CLAUDE_DIR */
  private watchProjectDirs(): void {
    // Watch the exact workspace project dir
    if (this.workspacePath) {
      const projectDir = path.join(CLAUDE_DIR, this.workspacePath)
      this.watchDirForJsonl(projectDir)
    }

    // Watch CLAUDE_DIR itself so we detect new subdirectory project dirs
    // (e.g. when a CLI session starts in a subfolder and creates a new project dir)
    if (this.workspacePath && fs.existsSync(CLAUDE_DIR)) {
      try {
        this.dirWatcher = fs.watch(CLAUDE_DIR, (_eventType, filename) => {
          if (!filename) return
          // A new project dir appeared — check if it's a subdirectory of our workspace
          const dirPath = path.join(CLAUDE_DIR, filename)
          try {
            if (fs.statSync(dirPath).isDirectory() && this.isContainedProject(filename)) {
              this.watchDirForJsonl(dirPath)
              this.scanForActiveSessions()
            }
          } catch { /* stat may fail for transient files */ }
        })
      } catch (err) { log.debug('CLAUDE_DIR watch failed:', err) }
    }
  }

  /** Watch a single project directory for new .jsonl files */
  private watchDirForJsonl(projectDir: string): void {
    if (this.dirWatchers.has(projectDir)) return // already watching
    if (!fs.existsSync(projectDir)) return
    try {
      const watcher = fs.watch(projectDir, (_eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          const sessionId = path.basename(filename, '.jsonl')
          if (!this.sessions.has(sessionId)) {
            this.scanForActiveSessions()
          }
        }
      })
      this.dirWatchers.set(projectDir, watcher)
    } catch (err) { log.debug('Dir watch failed (may not exist yet):', err) }
  }

  /** Check whether a project dir contains sessions running under the workspace.
   *  The encoded dir name is lossy (hyphens and path separators both become -),
   *  so instead of trying to decode it, we read the cwd from the JSONL files
   *  in the directory — that's the authoritative source of truth.
   *  Results are cached since a project dir's cwd never changes. */
  private isContainedProject(encodedDirName: string): boolean {
    if (!this.workspacePath || !this.resolvedWorkspace) return false
    // Quick prefix check to avoid reading files from obviously unrelated dirs
    if (!encodedDirName.startsWith(this.workspacePath + '-')) return false

    const cached = this.containedProjectCache.get(encodedDirName)
    if (cached !== undefined) return cached

    const result = this.readCwdFromProjectDir(encodedDirName)
    // Only cache positive results — a dir with no JSONL files yet (race on
    // creation) should be re-checked on the next scan once files appear.
    if (result) this.containedProjectCache.set(encodedDirName, true)
    return result
  }

  /** Read JSONL files in a project dir to find the cwd and check containment. */
  private readCwdFromProjectDir(encodedDirName: string): boolean {
    const dirPath = path.join(CLAUDE_DIR, encodedDirName)
    try {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        // Read enough to cover the first few lines (cwd is typically on line 3)
        const fd = fs.openSync(path.join(dirPath, file), 'r')
        try {
          const buf = Buffer.alloc(8192)
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0)
          if (bytesRead === 0) continue
          const lines = buf.toString('utf8', 0, bytesRead).split('\n')
          for (const line of lines) {
            if (!line.includes('"cwd"')) continue
            try {
              const entry = JSON.parse(line)
              if (typeof entry.cwd === 'string') {
                let cwd = entry.cwd
                try { cwd = fs.realpathSync(cwd) } catch { /* use as-is */ }
                return cwd === this.resolvedWorkspace
                  || cwd.startsWith(this.resolvedWorkspace + path.sep)
              }
            } catch { /* malformed line, try next */ }
          }
        } finally { fs.closeSync(fd) }
      }
    } catch { /* dir may not exist or be readable */ }
    return false
  }

  private scanForActiveSessions(): void {
    if (!fs.existsSync(CLAUDE_DIR)) {
      return
    }

    try {
      const dirsToScan: string[] = []
      if (this.workspacePath) {
        // Always include the exact workspace project dir
        const projectDir = path.join(CLAUDE_DIR, this.workspacePath)
        if (fs.existsSync(projectDir)) {
          dirsToScan.push(projectDir)
        }

        // Also include subdirectory project dirs (e.g. CLI sessions started
        // from a subfolder like project/extension/src). Uses containment check
        // to avoid matching unrelated projects with a similar path prefix.
        try {
          const allDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
          for (const dir of allDirs) {
            if (!dir.isDirectory()) continue
            const fullPath = path.join(CLAUDE_DIR, dir.name)
            if (fullPath === projectDir) continue // already added
            if (this.isContainedProject(dir.name)) {
              dirsToScan.push(fullPath)
            }
          }
        } catch { /* readdir may fail if CLAUDE_DIR is being modified */ }
      } else {
        const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
        for (const dir of projectDirs) {
          if (dir.isDirectory()) {
            dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
          }
        }
      }

      const activeFiles: { sessionId: string; filePath: string; mtime: number }[] = []

      for (const projectPath of dirsToScan) {
        try {
          const files = fs.readdirSync(projectPath)
          for (const file of files) {
            if (!file.endsWith('.jsonl')) { continue }
            const filePath = path.join(projectPath, file)
            const stat = fs.statSync(filePath)
            let newestMtime = stat.mtimeMs

            // Also check subagent files — a session's main JSONL may be stale
            // while subagents are still actively writing.
            const sessionId = path.basename(file, '.jsonl')
            const subagentsDir = path.join(projectPath, sessionId, 'subagents')
            try {
              if (fs.existsSync(subagentsDir)) {
                for (const subFile of fs.readdirSync(subagentsDir)) {
                  if (!subFile.endsWith('.jsonl')) continue
                  const subStat = fs.statSync(path.join(subagentsDir, subFile))
                  if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs
                }
              }
            } catch { /* expected if subagents dir doesn't exist yet */ }

            const ageSeconds = (Date.now() - newestMtime) / 1000
            if (ageSeconds <= ACTIVE_SESSION_AGE_S) {
              activeFiles.push({
                sessionId,
                filePath,
                mtime: newestMtime,
              })
            }
          }
        } catch (err) {
          log.debug('Failed to scan project dir:', err)
        }
      }

      // Start watching any new active files
      for (const af of activeFiles) {
        if (!this.sessions.has(af.sessionId)) {
          log.info(`Active session found: ${af.filePath}`)
          this.watchSession(af.sessionId, af.filePath)
        } else {
          // Already watching — scan for subagents
          scanSubagentsDir(this.selfDelegate, this.parser, af.sessionId)
        }
      }
    } catch (err) {
      log.error('Scan error:', err)
    }
  }

  private watchSession(sessionId: string, filePath: string): void {
    const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
    const session: WatchedSession = {
      sessionId,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      fileSize: 0,
      sessionStartTime: Date.now(),
      pendingToolCalls: new Map(),
      seenToolUseIds: new Set(),
      seenMessageHashes: new Set(),
      sessionDetected: false,
      sessionCompleted: false,
      lastActivityTime: this.newestMtime(filePath, sessionId),
      inactivityTimer: null,
      subagentWatchers: new Map(),
      spawnedSubagents: new Set(),
      inlineProgressAgents: new Set(),
      subagentsDirWatcher: null,
      subagentsDir: null,
      label: defaultLabel,
      labelSet: false,
      model: null,
      permissionTimer: null,
      permissionEmitted: false,
      contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    }
    this.sessions.set(sessionId, session)

    const stat = fs.statSync(filePath)

    // Pre-scan existing content for dedup IDs + collect recent entries for catch-up
    const catchUpEntries = this.parser.prescanExistingContent(filePath, stat.size, session)

    // Start from current end — only process NEW events going forward
    session.fileSize = stat.size

    // Extract session label from the first user message in catch-up entries
    this.parser.extractSessionLabel(catchUpEntries, session)

    // Emit session start
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label: session.label })

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
    session.sessionDetected = true

    // Emit initial context breakdown from prescan so the webview shows accumulated tokens
    this.emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)

    // Emit catch-up messages for content that was already in the file when we detected
    // the session (e.g. the first user message). These were pre-scanned for dedup/tokens
    // but never emitted as events. Emit them now so the webview shows the full history.
    this.parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

    // Watch for new content
    session.fileWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        this.readNewLines(sessionId)
      }
    })

    // Poll fallback — fs.watch on macOS can silently stop firing events
    // for long-lived watchers. This ensures we still detect new content.
    session.pollTimer = setInterval(() => {
      this.readNewLines(sessionId)
      // Also poll subagent files — fs.watch may not fire after extension restart
      for (const [subPath] of session.subagentWatchers) {
        readSubagentNewLines(this.selfDelegate, this.parser,subPath, sessionId)
      }
      scanSubagentsDir(this.selfDelegate, this.parser, sessionId)
    }, POLL_FALLBACK_MS)

    // Track subagents directory for this session
    session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
    scanSubagentsDir(this.selfDelegate, this.parser, sessionId)

    // Start inactivity timer so the session completes if no new content arrives
    this.resetInactivityTimer(sessionId)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) { return }

    const result = readNewFileLines(session.filePath, session.fileSize)
    if (!result) return
    session.fileSize = result.newSize
    for (const line of result.lines) {
      this.parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
    }

    // Detect permission-gated tool calls (skip Agent/Task — subagents are inherently slow)
    handlePermissionDetection(this.selfDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)

    // Check for new subagent files
    scanSubagentsDir(this.selfDelegate, this.parser, sessionId)

    // Reset inactivity timer — session is still active
    this.resetInactivityTimer(sessionId)
  }

  /** Reset the inactivity timer. When no new content arrives, emit agent_complete */
  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const wasCompleted = session.sessionCompleted
    session.lastActivityTime = Date.now()
    session.sessionCompleted = false

    // If the session was previously marked completed, re-emit agent_spawn
    // so the webview can receive events for this agent again, then notify
    // the frontend that it's active again.
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
        log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive — emitting orchestrator completion`)
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

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Get the newest mtime across a session's main JSONL and its subagent files. */
  private newestMtime(filePath: string, sessionId: string): number {
    let newest: number
    try { newest = fs.statSync(filePath).mtimeMs } catch { return Date.now() }
    const subDir = path.join(path.dirname(filePath), sessionId, 'subagents')
    try {
      if (fs.existsSync(subDir)) {
        for (const f of fs.readdirSync(subDir)) {
          if (!f.endsWith('.jsonl')) continue
          const mt = fs.statSync(path.join(subDir, f)).mtimeMs
          if (mt > newest) newest = mt
        }
      }
    } catch { /* expected if subagents dir doesn't exist yet */ }
    return newest
  }

  private elapsed(sessionId?: string): number {
    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (session) {
        return (Date.now() - session.sessionStartTime) / 1000
      }
    }
    return 0
  }

  /** Emit a context_update event with cumulative token breakdown */
  private emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string): void {
    const bd = session.contextBreakdown
    const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
    this.emit({
      time: this.elapsed(sessionId),
      type: 'context_update',
      payload: {
        agent: agentName,
        tokens: total,
        breakdown: { ...bd },
      },
    }, sessionId)
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this._onEvent.fire(sessionId ? { ...event, sessionId } : event)
  }

  dispose(): void {
    this.dirWatcher?.close()
    this.dirWatcher = null
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const [, session] of this.sessions) {
      session.fileWatcher?.close()
      if (session.pollTimer) { clearInterval(session.pollTimer) }
      if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
      if (session.permissionTimer) { clearTimeout(session.permissionTimer) }
      for (const [, sub] of session.subagentWatchers) {
        sub.watcher?.close()
        if (sub.permissionTimer) clearTimeout(sub.permissionTimer)
      }
      session.subagentWatchers.clear()
      session.subagentsDirWatcher?.close()
      // Clean up orphaned parser state for this session
      this.parser.clearSessionState(session.pendingToolCalls.keys())
    }
    this.sessions.clear()
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
