/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines, foldPathCase } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines } from '../extension/src/subagent-watcher'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
} from '../extension/src/constants'
import { setLogLevel } from '../extension/src/logger'
import type { TelemetryClient } from './telemetry'

const MAX_EVENT_BUFFER = 5000
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

let relayCreated = false
let verbose = false
let sessionEventCount = 0
/** Distinct model IDs seen across all watched sessions during this relay session.
 *  Populated from `model_detected` events (emitted by both the Claude transcript
 *  parser and the Codex rollout parser). Read at session_end for telemetry. */
const observedModels = new Set<string>()

// agent-flow-app version. Inlined by esbuild at bundle time via `define`.
// In dev (running from source via tsx), falls back to reading app/package.json.
declare const AGENT_FLOW_APP_VERSION: string | undefined
function resolveAgentFlowVersion(): string {
  try {
    if (typeof AGENT_FLOW_APP_VERSION === 'string' && AGENT_FLOW_APP_VERSION) {
      return AGENT_FLOW_APP_VERSION
    }
  } catch { /* ReferenceError in unbundled dev — fall through */ }
  try {
    const pkgPath = path.join(__dirname, '..', 'app', 'package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
    }
  } catch { /* ignore */ }
  return '0.0.0'
}

function log(...args: unknown[]) {
  if (verbose) console.log(...args)
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

// SSE ids let a reconnecting EventSource resume from where it left off
// (Last-Event-ID) instead of receiving every session's history again.
// BOOT_ID changes on every relay start so a stale id triggers a full reset.
const BOOT_ID = Math.random().toString(36).slice(2, 10)
let seq = 0

function sendSSE(res: http.ServerResponse, data: unknown, id?: number) {
  try {
    res.write(`${id !== undefined ? `id: ${BOOT_ID}:${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
  } catch {
    sseClients.delete(res)
  }
}

function broadcast(data: string, id?: number) {
  const frame = `${id !== undefined ? `id: ${BOOT_ID}:${id}\n` : ''}data: ${data}\n\n`
  for (const res of sseClients) {
    try { res.write(frame) } catch {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

interface BufferedEvent { seq: number; event: AgentEvent }
const eventBuffer = new Map<string, BufferedEvent[]>()

/** Events a late client cannot do without: everything else references these agents */
const STRUCTURAL_EVENTS = new Set<string>(['agent_spawn', 'subagent_dispatch', 'model_detected'])

/** While non-null, broadcastEvent() collects instead of sending — used to ship a replay as ONE batch frame */
let replayBatch: AgentEvent[] | null = null

function broadcastEvent(event: AgentEvent) {
  sessionEventCount++
  if (event.type === 'model_detected') {
    const m = (event.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${event.type} (session ${sid})`)

  const id = ++seq
  if (event.sessionId) {
    let buf = eventBuffer.get(event.sessionId) || []
    buf.push({ seq: id, event })
    if (buf.length > MAX_EVENT_BUFFER) {
      // Trim the oldest events but keep structural ones (spawns, models):
      // without them a late client gets a batch that references unknown agents
      const dropped = buf.slice(0, buf.length - MAX_EVENT_BUFFER).filter(b => STRUCTURAL_EVENTS.has(b.event.type))
      buf = dropped.concat(buf.slice(buf.length - MAX_EVENT_BUFFER))
    }
    eventBuffer.set(event.sessionId, buf)
  }

  if (replayBatch) { replayBatch.push(event); return }
  broadcast(JSON.stringify({ type: 'agent-event', event }), id)
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string, cwd?: string) {
  if (type === 'started') {
    broadcast(JSON.stringify({
      type: 'session-started',
      session: { id: sessionId, label, cwd, status: 'active', startTime: Date.now(), lastActivityTime: Date.now() } as SessionInfo,
    }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId, label, cwd }))
  }
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) {
      const raw = ((session.replayNow ?? Date.now()) - session.sessionStartTime - (session.compressedMs ?? 0)) / 1000
      // Timer- and subagent-driven emitters read the clock between advanceClock() calls;
      // clamp so no event is ever stamped earlier than the previous one
      session.lastElapsed = Math.max(raw, session.lastElapsed ?? 0)
      return session.lastElapsed
    }
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  if (session.replayNow != null) return // one context_update is emitted after the replay instead of one per line
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event)
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label, event.cwd),
  emitContextUpdate,
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
      sessionId,
    })
    broadcastSessionLifecycle('started', sessionId, session.label, session.cwd)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME },
        sessionId,
      })
      broadcastSessionLifecycle('ended', sessionId, session.label)
    }
  }, INACTIVITY_TIMEOUT_MS)
}

function watchSession(sessionId: string, filePath: string) {
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  const { entries, replayLines } = parser.prepareBackfill(filePath, stat.size, session)
  session.fileSize = stat.size
  parser.extractSessionLabel(entries, session)

  broadcastSessionLifecycle('started', sessionId, session.label, session.cwd)
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
    sessionId,
  })
  session.sessionDetected = true

  // Ship the whole replay as one frame: thousands of individual SSE messages
  // would trickle onto the canvas over many animation frames and look like playback
  replayBatch = []
  parser.replayLines(replayLines, session, sessionId)
  parser.advanceClock(session, Date.now()) // compress the gap between last entry and now
  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  const batch = replayBatch
  replayBatch = null
  if (batch.length > 0) broadcast(JSON.stringify({ type: 'agent-event-batch', events: batch }), seq)

  session.fileWatcher = fs.watch(filePath, (eventType) => {
    if (eventType === 'change') readNewLines(sessionId)
  })

  session.pollTimer = setInterval(() => {
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  }, POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize)
  if (!result) return
  session.fileSize = result.newSize
  if (result.lines.length > 0) parser.advanceClock(session, Date.now())
  for (const line of result.lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// ─── Session scanner ────────────────────────────────────────────────────────

function scanForActiveSessions(workspace: string) {
  if (!fs.existsSync(CLAUDE_DIR)) return

  let resolved = workspace
  try { resolved = fs.realpathSync(resolved) } catch {}
  const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')

  const dirsToScan: string[] = []
  // Case-folded on Windows — VS Code/shells report `c:\...` while Claude Code
  // encodes `C--...`, so exact string matching never found the project dir there.
  const encodedFolded = foldPathCase(encoded)
  try {
    for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const nameFolded = foldPathCase(dir.name)
      if (nameFolded === encodedFolded || nameFolded.startsWith(encodedFolded + '-')) {
        dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
      }
    }
  } catch {
    // readdir failed — fall back to the exact-match dir if it exists
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) dirsToScan.push(projectDir)
  }

  for (const dirPath of dirsToScan) {
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = path.basename(file, '.jsonl')

        let newestMtime = stat.mtimeMs
        const subagentsDir = path.join(dirPath, sessionId, 'subagents')
        try {
          if (fs.existsSync(subagentsDir)) {
            for (const subFile of fs.readdirSync(subagentsDir)) {
              if (!subFile.endsWith('.jsonl')) continue
              const subStat = fs.statSync(path.join(subagentsDir, subFile))
              if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs
            }
          }
        } catch {}

        const ageSeconds = (Date.now() - newestMtime) / 1000
        if (ageSeconds <= ACTIVE_SESSION_AGE_S && !sessions.has(sessionId)) {
          watchSession(sessionId, filePath)
        }
      }
    } catch {}
  }
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

function writeDiscoveryFile(port: number, workspace: string) {
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const hash = hashWorkspace(workspace)
  discoveryFilePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Clean up all resources */
  dispose: () => void
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_FLOW_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-flow-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_FLOW_RUNTIME
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  relayCreated = true

  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanInterval: NodeJS.Timeout | null = null
  let projectDirWatcher: fs.FSWatcher | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    hookServer.onEvent((event: AgentEvent) => {
      broadcast(JSON.stringify({ type: 'agent-event', event }))
    })

    writeDiscoveryFile(hookPort, workspace)

    scanForActiveSessions(workspace)
    scanInterval = setInterval(() => scanForActiveSessions(workspace), SCAN_INTERVAL_MS)

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = fs.watch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
        })
      } catch {}
    }
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycle.cwd)
    })
    codexWatcher.start()
  }

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentFlowVersion = resolveAgentFlowVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_flow_version: agentFlowVersion,
    os: os.platform(),
    arch: os.arch(),
  })

  telemetry?.emit({ ...baseEvent(), event_type: 'session_start' })

  process.on('uncaughtException', (err) => {
    try {
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'error',
        error_class: err?.constructor?.name ?? 'Error',
      })
    } catch { /* don't let the handler itself crash */ }
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  return {
    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      sseClients.add(res)
      log(`[sse] Client connected (${sseClients.size} total)`)

      req.on('close', () => {
        sseClients.delete(res)
        log(`[sse] Client disconnected (${sseClients.size} total)`)
      })

      // A reconnecting client sends Last-Event-ID: same boot → only what it missed;
      // different boot (relay restarted) → tell it to reset, then send everything.
      let afterSeq = -1
      const lastId = String(req.headers['last-event-id'] || '')
      if (lastId) {
        const [boot, n] = lastId.split(':')
        if (boot === BOOT_ID && Number.isFinite(Number(n))) afterSeq = Number(n)
        else sendSSE(res, { type: 'reset', reason: 'relay-restarted' })
      }
      // Send current session list (Claude + Codex)
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push({
          id: session.sessionId, label: session.label, cwd: session.cwd,
          status: session.sessionCompleted ? 'completed' : 'active',
          startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
        })
      }
      if (codexWatcher) sessionList.push(...codexWatcher.getActiveSessions())
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events for every session — the frontend buffers them
      // per session and flushes on selection, so switching tabs shows history
      // even for sessions attached before this client connected.
      for (const s of sessionList) {
        const buffered = (eventBuffer.get(s.id) || []).filter(b => b.seq > afterSeq)
        if (buffered.length > 0) sendSSE(res, { type: 'agent-event-batch', events: buffered.map(b => b.event) }, buffered[buffered.length - 1].seq)
      }
    },

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(',')
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'session_end',
        duration_s: Math.round((Date.now() - sessionStart) / 1000),
        event_count: sessionEventCount,
        models: models || undefined,
        runtimes: runtimes || undefined,
      })
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.dispose()
        if (scanInterval) clearInterval(scanInterval)
        projectDirWatcher?.close()
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
    },
  }
}
