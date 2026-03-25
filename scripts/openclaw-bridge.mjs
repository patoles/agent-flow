#!/usr/bin/env node
/**
 * openclaw-agent-flow-bridge.mjs
 *
 * Tails the active OpenClaw session JSONL and emits Claude Code-compatible
 * hook events to the Agent Flow standalone hook server (port 7842).
 *
 * Events emitted:
 *   SessionStart    — on startup (registers the session)
 *   PreToolUse      — when an assistant toolCall is appended
 *   PostToolUse     — when the following toolResult message is appended
 *   Message         — assistant text, user text, and thinking indicators
 *   SubagentStart   — when an Agent tool call is detected
 *   SubagentStop    — when the Agent tool result returns
 *   ModelChange     — when a model_change entry is found
 *   Stop            — when the session file hasn't grown for IDLE_MS (optional)
 *
 * Usage:
 *   node openclaw-agent-flow-bridge.mjs [session.jsonl]
 *   HOOK_SERVER_PORT=7842 OPENCLAW_SESSION_DIR=... node openclaw-agent-flow-bridge.mjs
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import os from 'os'
import crypto from 'crypto'

const HOOK_PORT = parseInt(process.env.HOOK_SERVER_PORT || '7842', 10)
const SESSION_DIR = process.env.OPENCLAW_SESSION_DIR
  || path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions')
const POLL_MS = 300          // how often to check for new lines
const IDLE_MS = 0            // disabled (was 30000) — idle Stop causes race with agent_complete
const SESSION_LABEL = 'OpenClaw (main)'

// ── OpenClaw → Claude Code tool name mapping ─────────────────────────────

const TOOL_NAME_MAP = {
  exec: 'Bash',
  process: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  browser: 'WebFetch',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  message: 'Reply',
  sessions_spawn: 'Agent',
  sessions_list: 'SessionList',
  subagents: 'Agent',
}

function mapToolName(name) {
  return TOOL_NAME_MAP[name] || name
}

/** Extract a human-readable summary from OpenClaw tool input */
function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  switch (toolName) {
    case 'exec':
    case 'process':
      return String(input.command || input.action || '').slice(0, 120)
    case 'read':
      return String(input.file_path || input.path || '')
    case 'write':
    case 'edit':
      return String(input.file_path || input.path || '')
    case 'browser':
    case 'web_fetch':
      return String(input.url || '').slice(0, 120)
    case 'web_search':
      return String(input.query || '').slice(0, 80)
    case 'message':
      return String(input.content || input.text || '').slice(0, 80)
    case 'sessions_spawn':
    case 'subagents':
      return String(input.prompt || input.description || '').slice(0, 80)
    default:
      return JSON.stringify(input).slice(0, 80)
  }
}

/** Strip OpenClaw system prefixes (Engram memory context, sender metadata) from user messages */
function cleanUserMessage(text) {
  // Find the LAST ``` block end — everything after it is the actual user message
  // OpenClaw wraps system context in markdown code fences, the user text follows the last one
  const parts = text.split(/```\s*\n/)
  if (parts.length >= 3) {
    // Take everything after the last code fence
    const lastPart = parts[parts.length - 1].trim()
    if (lastPart && !lastPart.startsWith('## ') && !lastPart.startsWith('Sender')) {
      return lastPart
    }
  }
  // Strategy 2: find timestamp marker
  const tsMatch = text.match(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[^\]]*\]\s*([\s\S]*)/i)
  if (tsMatch && tsMatch[1]?.trim()) {
    return tsMatch[1].trim()
  }
  // Strategy 3: if it's pure system context, skip
  if (text.startsWith('## Memory Context') || text.startsWith('Sender (untrusted')) {
    return ''
  }
  // Strategy 4: no system prefix, return as-is
  return text.trim()
}

// ── helpers ────────────────────────────────────────────────────────────────

function latestSessionFile(dir) {
  let best = null, bestMtime = 0
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const full = path.join(dir, f)
    const mt = fs.statSync(full).mtimeMs
    if (mt > bestMtime) { bestMtime = mt; best = full }
  }
  return best
}

function postEvent(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      hostname: '127.0.0.1',
      port: HOOK_PORT,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve(null))
    req.setTimeout(1500, () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

// ── session state ──────────────────────────────────────────────────────────

let sessionFile = process.argv[2] || latestSessionFile(SESSION_DIR)
if (!sessionFile) { console.error('[bridge] No session file found in', SESSION_DIR); process.exit(1) }

// Derive a stable session ID from the filename
const sessionId = path.basename(sessionFile, '.jsonl')
const cwd = os.homedir()

console.log('[bridge] Watching:', sessionFile)
console.log('[bridge] Session ID:', sessionId)
console.log('[bridge] Hook server: http://127.0.0.1:' + HOOK_PORT)

// Emit SessionStart so Agent Flow registers us
await postEvent({ hook_event_name: 'SessionStart', session_id: sessionId, cwd, label: SESSION_LABEL })
console.log('[bridge] SessionStart sent')

// ── tail loop ──────────────────────────────────────────────────────────────

// Start from end of file (live-only) by default. Set REPLAY_HISTORY=1 to replay full history.
const REPLAY_HISTORY = process.env.REPLAY_HISTORY === '1'
let filePos = REPLAY_HISTORY ? 0 : fs.statSync(sessionFile).size
let lastGrowthAt = Date.now()
let pendingToolCall = null   // { toolId, toolName, toolInput }
let pendingSubagents = new Map()  // toolCallId → { agentType, agentId, prompt }
let stopped = false          // true after idle Stop, reset on activity
let sessionStartTimestamp = null // ISO timestamp of the session entry, for elapsed time calc

async function poll() {
  let stat
  try { stat = fs.statSync(sessionFile) } catch { return }

  // If file rotated (new session) handle gracefully
  if (stat.size < filePos) { filePos = 0 }

  if (stat.size === filePos) {
    // No new data
    if (IDLE_MS > 0 && pendingToolCall === null && Date.now() - lastGrowthAt > IDLE_MS) {
      // Nothing for a while — no Stop spam (only once)
      lastGrowthAt = Date.now() + 1e9
      stopped = true
      await postEvent({ hook_event_name: 'Stop', session_id: sessionId, cwd })
      console.log('[bridge] Stop sent (idle)')
    }
    return
  }

  lastGrowthAt = Date.now()

  // Resume after idle stop — re-register the session so a new agent_spawn is emitted
  if (stopped) {
    stopped = false
    await postEvent({ hook_event_name: 'SessionStart', session_id: sessionId, cwd, label: SESSION_LABEL })
    console.log('[bridge] SessionStart re-sent (resumed after idle)')
  }

  const fd = fs.openSync(sessionFile, 'r')
  const chunk = Buffer.alloc(stat.size - filePos)
  fs.readSync(fd, chunk, 0, chunk.length, filePos)
  fs.closeSync(fd)
  filePos = stat.size

  const newText = chunk.toString('utf8')
  const lines = newText.split('\n').filter(l => l.trim())

  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }

    // ── session entry — capture start timestamp ──────────────────────────
    if (entry.type === 'session') {
      sessionStartTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
      continue
    }

    // Compute elapsed seconds from session start for proper timeline spacing
    const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
    const elapsedSec = sessionStartTimestamp
      ? Math.max(0, (entryTime - sessionStartTimestamp) / 1000)
      : 0

    // ── model_change ──────────────────────────────────────────────────────
    if (entry.type === 'model_change') {
      const modelId = entry.modelId || ''
      if (modelId) {
        await postEvent({ hook_event_name: 'ModelChange', session_id: sessionId, cwd, model_id: modelId, elapsed_sec: elapsedSec })
        console.log(`[bridge] ModelChange → ${modelId} @${elapsedSec.toFixed(1)}s`)
      }
      continue
    }

    if (entry.type !== 'message') continue
    const msg = entry.message || {}
    const role = msg.role
    const content = Array.isArray(msg.content) ? msg.content : []

    // ── assistant messages ────────────────────────────────────────────────
    if (role === 'assistant') {
      for (const c of content) {
        if (!c) continue

        // Thinking indicator
        if (c.type === 'thinking') {
          const thinkingText = c.thinking || c.text || ''
          await postEvent({
            hook_event_name: 'Message',
            session_id: sessionId,
            cwd,
            role: 'thinking',
            content: thinkingText ? thinkingText.slice(0, 500) : '[thinking...]',
            elapsed_sec: elapsedSec,
          })
          console.log(`[bridge] Message thinking @${elapsedSec.toFixed(1)}s`)
          continue
        }

        // Assistant text
        if (c.type === 'text' && c.text) {
          await postEvent({
            hook_event_name: 'Message',
            session_id: sessionId,
            cwd,
            role: 'assistant',
            content: c.text.slice(0, 1000),
            elapsed_sec: elapsedSec,
          })
          console.log(`[bridge] Message assistant @${elapsedSec.toFixed(1)}s`)
          continue
        }

        // Tool call
        if (c.type === 'toolCall') {
          const rawToolName = c.name || 'unknown'
          const toolName = mapToolName(rawToolName)
          const toolInput = c.arguments || {}
          pendingToolCall = { toolId: c.id, toolName: rawToolName, toolInput }

          // Build a clean summarized input for display
          const summarized = summarizeToolInput(rawToolName, toolInput)
          const cleanInput = { ...toolInput, _summary: summarized }

          // Detect Agent tool calls → SubagentStart
          if (rawToolName === 'Agent' || rawToolName === 'sessions_spawn' || rawToolName === 'subagents') {
            const agentType = toolInput.subagent_type || 'general-purpose'
            const agentId = c.id || crypto.randomUUID()
            const prompt = toolInput.prompt || toolInput.description || ''
            pendingSubagents.set(c.id, { agentType, agentId, prompt })
            await postEvent({
              hook_event_name: 'SubagentStart',
              session_id: sessionId,
              cwd,
              agent_type: agentType,
              agent_id: agentId,
              prompt: prompt.slice(0, 200),
              elapsed_sec: elapsedSec,
            })
            console.log(`[bridge] SubagentStart ${agentType} @${elapsedSec.toFixed(1)}s`)
          }

          const ev = {
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            cwd,
            tool_name: toolName,
            tool_input: cleanInput,
            elapsed_sec: elapsedSec,
          }
          const status = await postEvent(ev)
          console.log(`[bridge] PreToolUse ${toolName} → ${status}`)
        }
      }
    }

    // ── user messages ─────────────────────────────────────────────────────
    if (role === 'user') {
      for (const c of content) {
        if (!c) continue
        if (c.type === 'text' && c.text) {
          const cleaned = cleanUserMessage(c.text)
          if (!cleaned) continue  // skip empty/system-only messages
          await postEvent({
            hook_event_name: 'Message',
            session_id: sessionId,
            cwd,
            role: 'user',
            content: cleaned.slice(0, 500),
            elapsed_sec: elapsedSec,
          })
          console.log(`[bridge] Message user @${elapsedSec.toFixed(1)}s: "${cleaned.slice(0, 60)}"`)
        }
      }
    }

    // ── toolResult (role = "toolResult") ──────────────────────────────────
    if (role === 'toolResult') {
      const textContent = content.find(c => c && c.type === 'text')
      const rawResult = textContent ? textContent.text : ''
      const rawToolName = pendingToolCall?.toolName || 'unknown'
      const toolName = mapToolName(rawToolName)
      const toolInput = pendingToolCall?.toolInput || {}
      const toolId = pendingToolCall?.toolId

      // Check if this is a returning subagent
      if (toolId && pendingSubagents.has(toolId)) {
        const sub = pendingSubagents.get(toolId)
        pendingSubagents.delete(toolId)
        await postEvent({
          hook_event_name: 'SubagentStop',
          session_id: sessionId,
          cwd,
          agent_type: sub.agentType,
          agent_id: sub.agentId,
          elapsed_sec: elapsedSec,
        })
        console.log(`[bridge] SubagentStop ${sub.agentType} @${elapsedSec.toFixed(1)}s`)
      }

      const ev = {
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: rawResult.slice(0, 2000),  // cap size
        elapsed_sec: elapsedSec,
      }
      const status = await postEvent(ev)
      console.log(`[bridge] PostToolUse ${toolName} → ${status}`)
      pendingToolCall = null
    }
  }
}

// ── watch for new session files too ───────────────────────────────────────
function checkSessionRotate() {
  const latest = latestSessionFile(SESSION_DIR)
  if (latest && latest !== sessionFile) {
    console.log('[bridge] New session file detected:', latest)
    sessionFile = latest
    filePos = 0
    pendingToolCall = null
    pendingSubagents.clear()
    postEvent({ hook_event_name: 'SessionStart', session_id: path.basename(latest,'.jsonl'), cwd, label: SESSION_LABEL })
      .then(() => console.log('[bridge] SessionStart sent for new session'))
  }
}

setInterval(poll, POLL_MS)
// Only auto-rotate if no explicit session file was given
if (!process.argv[2]) setInterval(checkSessionRotate, 5000)

process.on('SIGINT', async () => {
  await postEvent({ hook_event_name: 'Stop', session_id: sessionId, cwd })
  console.log('\n[bridge] Stop sent, exiting')
  process.exit(0)
})

console.log('[bridge] Running — waiting for tool calls...')
