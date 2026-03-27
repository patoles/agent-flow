#!/usr/bin/env node
/**
 * Standalone dev relay server for Agent Flow.
 *
 * Replaces the VS Code extension during development by reusing the same
 * core modules (hook-server, session-watcher, transcript-parser, etc.).
 *
 *   1. Starts the HookServer (receives events from hook.js)
 *   2. Starts a lightweight session watcher (tails JSONL transcripts)
 *   3. Writes a discovery file (so hook.js knows where to forward)
 *   4. Relays all events to the browser via SSE
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ─── Import from extension source (single source of truth) ──────────────────

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines } from '../extension/src/subagent-watcher'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
} from '../extension/src/constants'

// ─── Config ─────────────────────────────────────────────────────────────────

const SSE_PORT = 3001
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

// ─── SSE relay (Server-Sent Events — plain HTTP) ────────────────────────────

const sseClients = new Set<http.ServerResponse>()

function createSSEServer(port: number) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      sseClients.add(res)
      console.log(`[sse] Client connected (${sseClients.size} total)`)

      req.on('close', () => {
        sseClients.delete(res)
        console.log(`[sse] Client disconnected (${sseClients.size} total)`)
      })

      // Send session list (single message, auto-selects once without racing)
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push({ id: session.sessionId, label: session.label, status: session.sessionCompleted ? 'completed' : 'active', startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime })
      }
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events for the auto-selected session (most recent active)
      const sorted = [...sessionList].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return bActive - aActive
        return b.lastActivityTime - a.lastActivityTime
      })
      if (sorted.length > 0) {
        const buffered = eventBuffer.get(sorted[0].id)
        if (buffered) {
          sendSSE(res, { type: 'agent-event-batch', events: buffered })
        }
      }
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Agent Flow Dev Relay')
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`SSE relay on http://127.0.0.1:${port}/events`)
  })

  return server
}

function sendSSE(res: http.ServerResponse, data: unknown) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch (e) {
    sseClients.delete(res)
  }
}

function broadcast(data: string) {
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch (e) {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering & broadcasting ─────────────────────────────────────────

const MAX_EVENT_BUFFER = 5000
const eventBuffer = new Map<string, AgentEvent[]>()

function broadcastEvent(event: AgentEvent) {
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  console.log(`[event] ${event.type} (session ${sid})`)

  // Buffer events per session for replay on SSE connect
  if (event.sessionId) {
    let buf = eventBuffer.get(event.sessionId) || []
    buf.push(event)
    if (buf.length > MAX_EVENT_BUFFER) {
      buf = buf.slice(buf.length - MAX_EVENT_BUFFER)
    }
    eventBuffer.set(event.sessionId, buf)
  }

  broadcast(JSON.stringify({ type: 'agent-event', event }))
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string) {
  if (type === 'started') {
    broadcast(JSON.stringify({
      type: 'session-started',
      session: { id: sessionId, label, status: 'active', startTime: Date.now(), lastActivityTime: Date.now() } as SessionInfo,
    }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId, label }))
  }
}

// ─── Session watcher (reuses TranscriptParser from extension) ───────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

const parser = new TranscriptParser({
  emit: (event: AgentEvent, sessionId?: string) => broadcastEvent(sessionId ? { ...event, sessionId } : event),
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label),
  emitContextUpdate,
})

const watcherDelegate = {
  emit: (event: AgentEvent, sessionId?: string) => broadcastEvent(sessionId ? { ...event, sessionId } : event),
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
    broadcastSessionLifecycle('started', sessionId, session.label)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      console.log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive — completing`)
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
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  const catchUpEntries = parser.prescanExistingContent(filePath, stat.size, session)
  session.fileSize = stat.size
  parser.extractSessionLabel(catchUpEntries, session)

  broadcastSessionLifecycle('started', sessionId, session.label)

  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
    sessionId,
  })
  session.sessionDetected = true

  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

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

  console.log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize)
  if (!result) return
  session.fileSize = result.newSize
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
  const encoded = resolved.replace(/[/\\:]/g, '-')

  const dirsToScan: string[] = []

  const projectDir = path.join(CLAUDE_DIR, encoded)
  if (fs.existsSync(projectDir)) dirsToScan.push(projectDir)

  try {
    for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const fullPath = path.join(CLAUDE_DIR, dir.name)
      if (fullPath === projectDir) continue
      if (dir.name.startsWith(encoded + '-')) {
        dirsToScan.push(fullPath)
      }
    }
  } catch {}

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
  console.log(`Discovery file: ${discoveryFilePath}`)
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const workspace = process.argv[2] || process.cwd()

  console.log('Starting Agent Flow dev relay...\n')
  console.log(`Workspace: ${workspace}`)

  // Start hook server (reused from extension)
  const hookServer = new HookServer()
  const hookPort = await hookServer.start()
  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    console.error('Failed to start hook server (port in use)')
    process.exit(1)
  }

  // Forward hook events to SSE clients
  hookServer.onEvent((event: AgentEvent) => {
    const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
    console.log(`[hook] ${event.type} (session ${sid})`)
    broadcast(JSON.stringify({ type: 'agent-event', event }))
  })

  // Start SSE relay
  createSSEServer(SSE_PORT)

  // Write discovery file
  writeDiscoveryFile(hookPort, workspace)

  // Start session watcher (JSONL transcript tailing)
  scanForActiveSessions(workspace)
  setInterval(() => scanForActiveSessions(workspace), SCAN_INTERVAL_MS)

  // Watch for new project directories
  const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
  const encoded = resolved.replace(/[/\\:]/g, '-')
  const projectDir = path.join(CLAUDE_DIR, encoded)
  if (fs.existsSync(projectDir)) {
    try {
      fs.watch(projectDir, (_eventType, filename) => {
        if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
      })
    } catch {}
  }

  // Cleanup on exit
  function cleanup() {
    removeDiscoveryFile()
    hookServer.dispose()
    for (const session of sessions.values()) {
      session.fileWatcher?.close()
      if (session.pollTimer) clearInterval(session.pollTimer)
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    }
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', removeDiscoveryFile)

  console.log('\nReady! Claude Code events will appear in the web app.')
}

main().catch(e => {
  console.error('Failed to start dev relay:', e)
  process.exit(1)
})
