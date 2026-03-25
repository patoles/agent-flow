#!/usr/bin/env node
/**
 * hook-server.mjs — Agent Flow standalone event hub
 *
 * Two-port architecture:
 *   HTTP  :7842  — Receives Claude Code–compatible hook events (POST /)
 *   WebSocket :7850/ws — Streams SimulationEvents to the Next.js browser client
 *
 * External tools (Claude Code hooks, the OpenClaw bridge, any MCP client) POST
 * JSON to :7842.  The server converts those hook payloads into SimulationEvents
 * and broadcasts them to every connected browser tab via WebSocket.
 *
 * Claude Code hook event → SimulationEvent mapping:
 *   SessionStart    → agent_spawn   (isMain: true)
 *   Stop            → agent_complete
 *   PreToolUse      → tool_call_start
 *   PostToolUse     → tool_call_end
 *   Message         → message
 *   SubagentStart   → subagent_dispatch + agent_spawn (child)
 *   SubagentStop    → subagent_return  + agent_complete (child)
 *   ModelChange     → model_detected
 */

import http from 'http'
import { WebSocketServer } from 'ws'

const HOOK_PORT = parseInt(process.env.HOOK_SERVER_PORT || '7842', 10)
const HUB_PORT  = parseInt(process.env.HUB_SERVER_PORT  || '7850', 10)
const MAX_EVENTS_PER_SESSION = 2000

// ── In-memory state ────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, label: string, status: 'active'|'completed', startTime: number, lastActivityTime: number }} HubSession
 * @typedef {{ time: number, type: string, payload: Record<string,unknown>, sessionId?: string }} SimEvent
 */

/** @type {Map<string, HubSession>} */
const sessions = new Map()

/** @type {Map<string, SimEvent[]>} */
const sessionEvents = new Map()

/** @type {Map<string, number>} session wall-clock start time (ms) */
const sessionWallStart = new Map()

/** @type {Map<string, Map<string, string>>} sessionId → (toolCallId → agentName) */
const pendingSubagents = new Map()

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set()

// ── helpers ────────────────────────────────────────────────────────────────

function now() { return Date.now() }

function simTime(sessionId) {
  const start = sessionWallStart.get(sessionId) ?? now()
  return (now() - start) / 1000
}

function pushEvent(sessionId, event) {
  let buf = sessionEvents.get(sessionId)
  if (!buf) { buf = []; sessionEvents.set(sessionId, buf) }
  if (buf.length >= MAX_EVENTS_PER_SESSION) buf.shift()
  buf.push(event)

  // Update session activity timestamp
  const sess = sessions.get(sessionId)
  if (sess) sess.lastActivityTime = now()

  broadcast({ type: 'event', event })
}

function broadcast(msg) {
  const str = JSON.stringify(msg)
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(str) } catch { /* ignore */ }
    }
  }
}

// ── Tool summarization ─────────────────────────────────────────────────────

function summarizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  const s = String
  switch (toolName.toLowerCase()) {
    case 'bash':
    case 'exec':
      return s(input.command || input.cmd || '').slice(0, 120)
    case 'read':
      return s(input.file_path || input.path || '')
    case 'write':
    case 'edit':
      return s(input.file_path || input.path || '')
    case 'webfetch':
    case 'web_fetch':
      return s(input.url || '').slice(0, 120)
    case 'websearch':
    case 'web_search':
      return s(input.query || '').slice(0, 80)
    case 'grep':
    case 'globsearch':
      return s(input.pattern || input.glob || '').slice(0, 80)
    case 'todoread':
    case 'todowrite':
      return s(input.todos?.[0]?.content || '').slice(0, 60)
    case 'agent':
    case 'sessions_spawn':
    case 'subagents':
      return s(input.prompt || input.task || input.description || '').slice(0, 80)
    case 'memory_search':
    case 'memory_store':
      return s(input.query || input.content || '').slice(0, 80)
    default: {
      // Generic: probe common summary keys in priority order
      const keys = ['command', 'query', 'url', 'path', 'file_path', 'content', 'message', 'text', 'description', 'task']
      for (const k of keys) {
        const v = input[k]
        if (v && typeof v === 'string') return v.slice(0, 80)
      }
      return JSON.stringify(input).slice(0, 80)
    }
  }
}

function summarizeResult(toolName, result) {
  if (!result || typeof result !== 'string') return ''
  // First non-empty line, trimmed
  const line = result.split('\n').find(l => l.trim())
  return (line || result).slice(0, 120)
}

// ── Hook event → SimulationEvent translation ───────────────────────────────

function handleHookEvent(body) {
  const evt  = body.hook_event_name || body.event || ''
  const sid  = body.session_id || 'default'
  const cwd  = body.cwd || process.cwd()
  const t    = typeof body.elapsed_sec === 'number'
                 ? body.elapsed_sec
                 : simTime(sid)

  if (!sessions.has(sid)) {
    // Auto-create session on first event
    const label = body.label || cwd.split('/').pop() || sid.slice(0, 8)
    sessions.set(sid, { id: sid, label, status: 'active', startTime: now(), lastActivityTime: now() })
    sessionWallStart.set(sid, now())
    pendingSubagents.set(sid, new Map())
    broadcast({ type: 'session-started', session: sessions.get(sid) })
  }

  switch (evt) {
    case 'SessionStart': {
      const label = body.label || cwd.split('/').pop() || sid.slice(0, 8)
      // Update or create
      const existing = sessions.get(sid)
      if (existing) {
        existing.label = label
        existing.status = 'active'
        broadcast({ type: 'session-updated', sessionId: sid, label })
      } else {
        sessionWallStart.set(sid, now())
      }
      pendingSubagents.set(sid, new Map())
      pushEvent(sid, { time: t, type: 'agent_spawn', sessionId: sid, payload: {
        agent: sid, cwd, isMain: true, task: label,
      }})
      break
    }

    case 'Stop': {
      const sess = sessions.get(sid)
      if (sess) sess.status = 'completed'
      broadcast({ type: 'session-ended', sessionId: sid })
      pushEvent(sid, { time: t, type: 'agent_complete', sessionId: sid, payload: { agent: sid } })
      break
    }

    case 'PreToolUse': {
      const rawTool = body.tool_name || 'unknown'
      const input   = body.tool_input || {}
      const args    = summarizeInput(rawTool, input)
      pushEvent(sid, { time: t, type: 'tool_call_start', sessionId: sid, payload: {
        agent: sid, tool: rawTool, args, inputData: input,
      }})
      break
    }

    case 'PostToolUse': {
      const rawTool = body.tool_name || 'unknown'
      const result  = typeof body.tool_response === 'string' ? body.tool_response : JSON.stringify(body.tool_response || '')
      const summary = summarizeResult(rawTool, result)
      const isError = /error|failed|exception/i.test(result.slice(0, 200))
      pushEvent(sid, { time: t, type: 'tool_call_end', sessionId: sid, payload: {
        agent: sid, tool: rawTool, result: summary, error: isError,
      }})
      break
    }

    case 'Message': {
      const role    = body.role || 'assistant'
      const content = body.content || ''
      pushEvent(sid, { time: t, type: 'message', sessionId: sid, payload: {
        agent: sid, role, content,
      }})
      break
    }

    case 'SubagentStart': {
      const agentType = body.agent_type || 'subagent'
      const agentId   = body.agent_id   || `sub-${t.toFixed(0)}`
      const prompt    = body.prompt     || ''
      const sub = pendingSubagents.get(sid)
      if (sub) sub.set(agentId, agentId)
      // Dispatch event from parent
      pushEvent(sid, { time: t, type: 'subagent_dispatch', sessionId: sid, payload: {
        agent: sid, childAgent: agentId, task: prompt,
      }})
      // Spawn the child agent node
      pushEvent(sid, { time: t, type: 'agent_spawn', sessionId: sid, payload: {
        agent: agentId, cwd, isMain: false, parentAgent: sid, task: prompt,
      }})
      break
    }

    case 'SubagentStop': {
      const agentId = body.agent_id || ''
      const sub = pendingSubagents.get(sid)
      if (sub) sub.delete(agentId)
      pushEvent(sid, { time: t, type: 'agent_complete', sessionId: sid, payload: {
        agent: agentId,
      }})
      pushEvent(sid, { time: t, type: 'subagent_return', sessionId: sid, payload: {
        agent: sid, childAgent: agentId,
      }})
      break
    }

    case 'ModelChange': {
      pushEvent(sid, { time: t, type: 'model_detected', sessionId: sid, payload: {
        agent: sid, model: body.model_id || '',
      }})
      break
    }

    default:
      // Unknown event — silently ignore
      break
  }
}

// ── HTTP hook receiver (port 7842) ─────────────────────────────────────────

const hookServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method Not Allowed'); return
  }

  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    try {
      const body = JSON.parse(raw)
      handleHookEvent(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      console.error('[hook-server] parse error:', err.message)
      res.writeHead(400); res.end('Bad Request')
    }
  })
})

hookServer.listen(HOOK_PORT, '127.0.0.1', () => {
  console.log(`[hook-server] HTTP hook receiver listening on http://127.0.0.1:${HOOK_PORT}`)
})

// ── WebSocket hub (port 7850) ───────────────────────────────────────────────

const hubServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Agent Flow Event Hub\n')
})

const wss = new WebSocketServer({ server: hubServer, path: '/ws' })

wss.on('connection', (ws) => {
  wsClients.add(ws)
  console.log(`[hub] Client connected (total: ${wsClients.size})`)

  // Send the current session list immediately
  const sessionList = [...sessions.values()]
  const mostRecent  = sessionList.sort((a, b) => b.lastActivityTime - a.lastActivityTime)[0]
  ws.send(JSON.stringify({
    type: 'session-list',
    sessions: sessionList,
    selectedSessionId: mostRecent?.id,
  }))

  // Replay buffered events for the most recent session
  if (mostRecent) {
    const events = sessionEvents.get(mostRecent.id) || []
    if (events.length > 0) {
      ws.send(JSON.stringify({ type: 'event-batch', events }))
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'select-session' && msg.sessionId) {
        const events = sessionEvents.get(msg.sessionId) || []
        ws.send(JSON.stringify({ type: 'event-batch', events }))
      }
    } catch { /* ignore */ }
  })

  ws.on('close', () => {
    wsClients.delete(ws)
    console.log(`[hub] Client disconnected (total: ${wsClients.size})`)
  })

  ws.on('error', () => wsClients.delete(ws))
})

hubServer.listen(HUB_PORT, () => {
  console.log(`[hub] WebSocket hub listening on ws://localhost:${HUB_PORT}/ws`)
})

console.log('[agent-flow] Hook server ready. Waiting for events...')
console.log('[agent-flow] Run the bridge with: node scripts/openclaw-bridge.mjs')
