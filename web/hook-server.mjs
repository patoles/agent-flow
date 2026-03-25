#!/usr/bin/env node
/**
 * Agent Flow standalone hook server.
 *
 * Replaces the VS Code extension as the hook receiver when running in
 * web / standalone mode (npm run dev:standalone). It:
 *
 *  1. Picks a fixed port (default 7842, override with HOOK_SERVER_PORT)
 *     and writes a discovery file to
 *     ~/.claude/agent-flow/{workspace-hash}-{pid}.json
 *     so that hook.js knows where to forward events.
 *
 *  2. Receives HTTP POSTs from hook.js (raw Claude Code hook payloads).
 *
 *  3. Converts the raw payloads to AgentEvent format (same as the
 *     VS Code extension does in hook-server.ts).
 *
 *  4. Broadcasts converted events + session lifecycle messages to all
 *     connected browsers via Server-Sent Events on GET /hook-events.
 *
 *  5. Cleans up the discovery file on exit.
 *
 * The Next.js app proxies /hook-events to this server (see next.config.mjs)
 * and switches out of mock-data mode as soon as the SSE stream opens.
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'

const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const WORKSPACE_HASH_LENGTH = 16
const SSE_PORT = process.env.HOOK_SERVER_PORT ? parseInt(process.env.HOOK_SERVER_PORT) : 7842

// ── constants (mirrors extension/src/constants.ts) ───────────────────────────
const ORCHESTRATOR_NAME = 'orchestrator'
const SESSION_ID_DISPLAY = 8
const PREVIEW_MAX = 60
const RESULT_MAX = 200
const FAILED_RESULT_MAX = 100
const SUBAGENT_ID_SUFFIX_LENGTH = 6

// ── helpers ──────────────────────────────────────────────────────────────────
function hashWorkspace(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
function writeDiscovery(port) {
  ensureDir(DISCOVERY_DIR)
  const cwd = process.cwd()
  const hash = hashWorkspace(cwd)
  const filePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ port, pid: process.pid, workspace: path.resolve(cwd) }, null, 2) + '\n')
  console.log(`[hook-server] discovery → ${filePath}`)
  return filePath
}
function removeDiscovery(filePath) {
  try { fs.unlinkSync(filePath) } catch { /* already gone */ }
}

// ── tool summarizer (simplified port of extension/src/tool-summarizer.ts) ───

function summarizeInput(toolName, input) {
  if (!input) return ''
  switch (toolName) {
    case 'Bash': return String(input.command || '').slice(0, 80)
    case 'Read': return String(input.file_path || input.path || '')
    case 'Write': return String(input.file_path || input.path || '')
    case 'Edit': return String(input.file_path || input.path || '')
    case 'WebFetch': return String(input.url || '')
    case 'WebSearch': return String(input.query || '')
    case 'Task': return String(input.description || input.prompt || '').slice(0, 80)
    default: return JSON.stringify(input).slice(0, 80)
  }
}

function summarizeResult(result) {
  if (typeof result === 'string') return result.slice(0, RESULT_MAX)
  if (Array.isArray(result)) return result.map(r => r.text || '').join('').slice(0, RESULT_MAX)
  if (result && typeof result === 'object' && 'content' in result) return String(result.content).slice(0, RESULT_MAX)
  return JSON.stringify(result).slice(0, RESULT_MAX)
}

// ── session state ─────────────────────────────────────────────────────────────

const sessionStartTimes = new Map()  // session_id → start timestamp ms
const agentNames = new Map()          // agent_id → friendly name
const sessions = new Map()            // session_id → SessionInfo

function elapsedSeconds(sessionId) {
  const start = sessionStartTimes.get(sessionId) || Date.now()
  return (Date.now() - start) / 1000
}

function resolveAgentName(payload) {
  if (payload.agent_id && agentNames.has(payload.agent_id)) return agentNames.get(payload.agent_id)
  return ORCHESTRATOR_NAME
}

function generateSubagentFallbackName(id, index) {
  return `subagent-${id.length > SUBAGENT_ID_SUFFIX_LENGTH ? id.slice(-SUBAGENT_ID_SUFFIX_LENGTH) : index}`
}

// ── SSE clients ───────────────────────────────────────────────────────────────

const clients = new Set()

function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch { clients.delete(res) }
  }
}

function emitEvent(event, sessionId) {
  broadcast({ type: 'agent-event', event: sessionId ? { ...event, sessionId } : event })
}

// ── hook event handler (mirrors extension/src/hook-server.ts) ─────────────────

function handleHook(payload) {
  const eventName = payload.hook_event_name
  switch (eventName) {
    case 'SessionStart':   handleSessionStart(payload); break
    case 'PreToolUse':     handlePreToolUse(payload); break
    case 'PostToolUse':    handlePostToolUse(payload); break
    case 'PostToolUseFailure': handlePostToolUseFailure(payload); break
    case 'SubagentStart':  handleSubagentStart(payload); break
    case 'SubagentStop':   handleSubagentStop(payload); break
    case 'Notification':   handleNotification(payload); break
    case 'Stop':           handleStop(payload); break
    case 'SessionEnd':     handleSessionEnd(payload); break
    default:
      console.log(`[hook-server] unknown event: ${eventName}`)
  }
}

function handleSessionStart(payload) {
  const sid = payload.session_id
  sessionStartTimes.set(sid, Date.now())
  const session = {
    id: sid,
    label: `Session ${sid.slice(0, SESSION_ID_DISPLAY)}`,
    status: 'active',
    startTime: Date.now(),
    lastActivityTime: Date.now(),
  }
  sessions.set(sid, session)
  broadcast({ type: 'session-started', session })
  emitEvent({ time: 0, type: 'agent_spawn', payload: { name: ORCHESTRATOR_NAME, isMain: true, task: `Session ${sid.slice(0, SESSION_ID_DISPLAY)}` } }, sid)
}

function ensureSessionExists(payload) {
  if (!sessionStartTimes.has(payload.session_id)) {
    handleSessionStart(payload)
  }
}

function touchSession(sid) {
  const s = sessions.get(sid)
  if (s) { s.lastActivityTime = Date.now(); broadcast({ type: 'session-updated', sessionId: sid, label: s.label }) }
}

function handlePreToolUse(payload) {
  ensureSessionExists(payload)
  const agentName = resolveAgentName(payload)
  const toolName = payload.tool_name || 'unknown'
  const args = summarizeInput(toolName, payload.tool_input)
  touchSession(payload.session_id)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'tool_call_start', payload: { agent: agentName, tool: toolName, args, preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX) } }, payload.session_id)
}

function handlePostToolUse(payload) {
  const agentName = resolveAgentName(payload)
  const toolName = payload.tool_name || 'unknown'
  const result = payload.tool_response ? summarizeResult(payload.tool_response) : ''
  touchSession(payload.session_id)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'tool_call_end', payload: { agent: agentName, tool: toolName, result: result.slice(0, RESULT_MAX), tokenCost: 0 } }, payload.session_id)
}

function handlePostToolUseFailure(payload) {
  const agentName = resolveAgentName(payload)
  const toolName = payload.tool_name || 'unknown'
  const result = payload.tool_response ? summarizeResult(payload.tool_response) : ''
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'tool_call_end', payload: { agent: agentName, tool: toolName, result: `[FAILED] ${result.slice(0, FAILED_RESULT_MAX)}`, tokenCost: 0 } }, payload.session_id)
}

function handleSubagentStart(payload) {
  const parentName = resolveAgentName(payload)
  const agentType = payload.agent_type || 'subagent'
  const agentId = payload.agent_id || ''
  const childName = agentId ? `${agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}` : generateSubagentFallbackName(String(Date.now()), agentNames.size + 1)
  agentNames.set(agentId, childName)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'agent_spawn', payload: { name: childName, parent: parentName, agentType } }, payload.session_id)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'subagent_dispatch', payload: { parent: parentName, child: childName, agentType } }, payload.session_id)
}

function handleSubagentStop(payload) {
  const agentId = payload.agent_id || ''
  const childName = agentNames.get(agentId) || 'subagent'
  const parentName = resolveAgentName(payload)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'subagent_return', payload: { child: childName, parent: parentName, summary: `${payload.agent_type} complete` } }, payload.session_id)
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'agent_complete', payload: { name: childName } }, payload.session_id)
}

function handleNotification(payload) {
  if (payload.notification_type !== 'permission_prompt') return
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'permission_requested', payload: { agent: ORCHESTRATOR_NAME, message: payload.message || 'Permission needed', title: payload.title || 'Permission needed' } }, payload.session_id)
}

function handleStop(payload) {
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'agent_complete', payload: { name: ORCHESTRATOR_NAME } }, payload.session_id)
  const s = sessions.get(payload.session_id)
  if (s) { s.status = 'completed'; broadcast({ type: 'session-ended', sessionId: payload.session_id }) }
}

function handleSessionEnd(payload) {
  emitEvent({ time: elapsedSeconds(payload.session_id), type: 'agent_complete', payload: { name: ORCHESTRATOR_NAME, sessionEnd: true } }, payload.session_id)
  const s = sessions.get(payload.session_id)
  if (s) { s.status = 'completed'; broadcast({ type: 'session-ended', sessionId: payload.session_id }) }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // SSE — browser subscribes here
  if (req.method === 'GET' && req.url === '/hook-events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    res.write(': connected\n\n')
    // Send existing session list immediately
    if (sessions.size > 0) {
      res.write(`data: ${JSON.stringify({ type: 'session-list', sessions: Array.from(sessions.values()) })}\n\n`)
    }
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  // Hook receiver — Claude Code POSTs here
  if (req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)
        if (payload && payload.session_id && payload.hook_event_name) {
          console.log(`[hook-server] ${payload.hook_event_name} ${payload.tool_name || ''} (session ${payload.session_id.slice(0, 8)}, ${clients.size} clients)`)
          handleHook(payload)
        }
      } catch (e) { console.error('[hook-server] parse error:', e.message) }
      res.writeHead(200); res.end()
    })
    return
  }

  res.writeHead(404); res.end()
})

// ── startup ────────────────────────────────────────────────────────────────────

server.listen(SSE_PORT, '127.0.0.1', () => {
  const discoveryFile = writeDiscovery(SSE_PORT)
  console.log(`[hook-server] listening on http://127.0.0.1:${SSE_PORT}`)
  console.log(`[hook-server] SSE stream: http://127.0.0.1:${SSE_PORT}/hook-events`)
  console.log(`[hook-server] waiting for Claude Code hook events...`)

  const cleanup = () => { removeDiscovery(discoveryFile); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', () => removeDiscovery(discoveryFile))
})
