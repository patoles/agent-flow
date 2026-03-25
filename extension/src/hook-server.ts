import * as http from 'http'
import * as vscode from 'vscode'
import { AgentEvent, emitSubagentSpawn } from './protocol'
import {
  ORCHESTRATOR_NAME, PREVIEW_MAX, RESULT_MAX,
  SESSION_ID_DISPLAY, FAILED_RESULT_MAX, HOOK_MAX_BODY_SIZE,
  SUBAGENT_ID_SUFFIX_LENGTH, HOOK_SERVER_HOST, HOOK_SERVER_NOT_STARTED,
  generateSubagentFallbackName,
} from './constants'
import { summarizeInput, summarizeResult, extractFilePath, buildDiscovery } from './tool-summarizer'
import { estimateTokenCost } from './token-estimator'
import { createLogger } from './logger'

const log = createLogger('HookServer')

/**
 * Lightweight HTTP server that receives Claude Code hook events.
 *
 * Claude Code hooks POST JSON payloads for events like PreToolUse, PostToolUse,
 * SubagentStart, SubagentStop, SessionStart, Stop, etc.
 *
 * We transform these into AgentEvent format and emit them.
 */

/** Port 0 = let OS assign a random available port */

interface HookPayload {
  session_id: string
  transcript_path?: string
  cwd?: string
  hook_event_name: string
  // PreToolUse / PostToolUse
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  tool_response?: string | { content: string } | Array<{ text?: string }>
  // SubagentStart / SubagentStop
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  // Notification
  notification_type?: string
  message?: string
  title?: string
  // Generic
  [key: string]: unknown
}

export class HookServer implements vscode.Disposable {
  private server: http.Server | null = null
  private port: number
  /** Per-session state — cleaned up on SessionEnd/Stop to prevent unbounded growth */
  private sessionState = new Map<string, {
    startTime: number
    agentNames: Map<string, string> // agent_id → friendly name
  }>()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()

  readonly onEvent = this._onEvent.event

  constructor(port?: number) {
    this.port = port ?? 0
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST') {
          let body = ''
          let oversized = false
          req.on('data', (chunk: Buffer) => {
            if (oversized) return
            body += chunk.toString()
            if (body.length > HOOK_MAX_BODY_SIZE) {
              oversized = true
              body = ''
              log.warn('Request body exceeded size limit, discarding')
            }
          })
          req.on('end', () => {
            if (!oversized) {
              try {
                const parsed: unknown = JSON.parse(body)
                if (!parsed || typeof parsed !== 'object' || !('session_id' in parsed) || !('hook_event_name' in parsed)
                    || typeof (parsed as HookPayload).session_id !== 'string'
                    || typeof (parsed as HookPayload).hook_event_name !== 'string') {
                  log.warn('Invalid hook payload: missing session_id or hook_event_name')
                } else {
                  this.handleHook(parsed as HookPayload)
                }
              } catch (e) {
                log.error('Failed to parse payload:', e)
              }
            }
            // Always return 200 with empty body — we're observing, not blocking.
            // Empty body = "success, no output" per Claude Code docs.
            // Returning JSON (even '{}') triggers schema parsing which can cause issues.
            res.writeHead(200)
            res.end()
          })
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Agent Visualizer Hook Server')
        }
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Another instance already owns this port — skip instead of incrementing
          // to a port nobody sends to. The session watcher handles all events via JSONL.
          log.info(`Port ${this.port} in use (another instance owns it) — skipping hook server`)
          this.server?.close()
          this.server = null
          resolve(HOOK_SERVER_NOT_STARTED)
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, HOOK_SERVER_HOST, () => {
        const addr = this.server!.address() as { port: number }
        this.port = addr.port
        log.info(`Listening on http://127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  private getOrCreateSession(sessionId: string): { startTime: number; agentNames: Map<string, string> } {
    let state = this.sessionState.get(sessionId)
    if (!state) {
      state = { startTime: Date.now(), agentNames: new Map() }
      this.sessionState.set(sessionId, state)
    }
    return state
  }

  private elapsedSeconds(sessionId?: string): number {
    const startTime = sessionId ? (this.sessionState.get(sessionId)?.startTime ?? Date.now()) : Date.now()
    return (Date.now() - startTime) / 1000
  }

  private handleHook(payload: HookPayload): void {
    const eventName = payload.hook_event_name
    log.debug(eventName, payload.tool_name || payload.agent_type || '')

    switch (eventName) {
      case 'SessionStart':
        this.handleSessionStart(payload)
        break
      case 'PreToolUse':
        this.handlePreToolUse(payload)
        break
      case 'PostToolUse':
        this.handlePostToolUse(payload)
        break
      case 'PostToolUseFailure':
        this.handlePostToolUseFailure(payload)
        break
      case 'SubagentStart':
        this.handleSubagentStart(payload)
        break
      case 'SubagentStop':
        this.handleSubagentStop(payload)
        break
      case 'Notification':
        this.handleNotification(payload)
        break
      case 'Stop':
        this.handleStop(payload)
        break
      case 'SessionEnd':
        this.handleSessionEnd(payload)
        break
    }
  }

  private handleSessionStart(payload: HookPayload): void {
    this.getOrCreateSession(payload.session_id)

    this.emit({
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME,
        isMain: true,
        task: `Session ${payload.session_id.slice(0, SESSION_ID_DISPLAY)}`,
      },
    }, payload.session_id)
  }

  private handlePreToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const args = summarizeInput(toolName, payload.tool_input)

    // If this is the first event and no session start was received, auto-spawn
    if (!this.sessionState.has(payload.session_id)) {
      this.handleSessionStart(payload)
    }

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
      },
    }, payload.session_id)
  }

  private handlePostToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const result = payload.tool_response ? summarizeResult(payload.tool_response) : ''
    const tokenCost = estimateTokenCost(toolName, result)

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, extractFilePath(payload.tool_input), result)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, RESULT_MAX),
        tokenCost,
        ...(discovery ? { discovery } : {}),
      },
    }, payload.session_id)
  }

  private handlePostToolUseFailure(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: `[FAILED] ${(payload.tool_response ? summarizeResult(payload.tool_response) : '').slice(0, FAILED_RESULT_MAX)}`,
        tokenCost: 0,
      },
    }, payload.session_id)
  }

  private handleSubagentStart(payload: HookPayload): void {
    const parentName = this.resolveAgentName(payload)
    const agentType = payload.agent_type || 'subagent'
    const agentId = payload.agent_id || ''
    const sessionAgents = this.getOrCreateSession(payload.session_id).agentNames
    const childName = agentId ? `${agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}` : generateSubagentFallbackName(String(Date.now()), sessionAgents.size + 1)

    sessionAgents.set(agentId, childName)

    emitSubagentSpawn(
      { emit: (e, s) => this.emit(e, s), elapsed: (s) => this.elapsedSeconds(s) },
      parentName, childName, agentType, payload.session_id,
    )
  }

  private handleSubagentStop(payload: HookPayload): void {
    const agentId = payload.agent_id || ''
    const sessionAgents = this.sessionState.get(payload.session_id)?.agentNames
    const childName = sessionAgents?.get(agentId) || 'subagent'
    const parentName = this.resolveAgentName(payload)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'subagent_return',
      payload: { child: childName, parent: parentName, summary: `${payload.agent_type} complete` },
    }, payload.session_id)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: childName },
    }, payload.session_id)
  }

  private handleNotification(payload: HookPayload): void {
    if (payload.notification_type !== 'permission_prompt') return

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'permission_requested',
      payload: {
        agent: ORCHESTRATOR_NAME,
        message: payload.message || 'Permission needed',
        title: payload.title || 'Permission needed',
      },
    }, payload.session_id)
  }

  private handleStop(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME },
    }, payload.session_id)
  }

  private handleSessionEnd(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
    }, payload.session_id)

    // Clean up per-session state to prevent unbounded Map growth
    this.sessionState.delete(payload.session_id)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private resolveAgentName(payload: HookPayload): string {
    // If this event has an agent_id, look it up in the session's agent names.
    if (payload.agent_id) {
      const name = this.sessionState.get(payload.session_id)?.agentNames.get(payload.agent_id)
      if (name) return name
    }
    return ORCHESTRATOR_NAME
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this._onEvent.fire(sessionId ? { ...event, sessionId } : event)
  }

  dispose(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.sessionState.clear()
    this._onEvent.dispose()
  }
}
