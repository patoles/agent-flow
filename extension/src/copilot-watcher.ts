import * as vscode from 'vscode'
import { AgentEvent, SessionInfo } from './protocol'
import { ORCHESTRATOR_NAME } from './constants'
import { createLogger } from './logger'

const log = createLogger('CopilotWatcher')

const COPILOT_SESSION_PREFIX = 'copilot-'
const COPILOT_AGENT_NAME = 'Copilot'

/**
 * Watches GitHub Copilot Chat activity via the VS Code Chat API.
 *
 * Unlike Claude Code (which writes JSONL transcripts), Copilot Chat events
 * are observed through the VS Code extension API:
 *   - Chat response events (onDidPerformAction)
 *   - Language model tool invocations
 *   - Chat request/response lifecycle
 *
 * Events are translated to the same AgentEvent format used by the rest
 * of the visualizer so the webview treats them identically.
 */
export class CopilotWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = []
  private active = false
  private sessionCounter = 0
  private sessions = new Map<string, CopilotSession>()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new vscode.EventEmitter<string>()
  private readonly _onSessionLifecycle = new vscode.EventEmitter<{
    type: 'started' | 'ended' | 'updated'
    sessionId: string
    label: string
  }>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  isActive(): boolean {
    return this.active
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      label: s.label,
      status: s.completed ? 'completed' as const : 'active' as const,
      startTime: s.startTime,
      lastActivityTime: s.lastActivityTime,
    }))
  }

  start(): void {
    if (this.active) return

    const enabled = vscode.workspace.getConfiguration('agentVisualizer').get<boolean>('watchCopilotChat', true)
    if (!enabled) {
      log.info('Copilot Chat watching disabled by setting')
      return
    }

    // Watch for chat action events (available in VS Code 1.93+)
    // Use runtime check since @types/vscode may not include this yet
    try {
      const chatNs = vscode.chat as Record<string, unknown>
      if (typeof chatNs.onDidPerformAction === 'function') {
        const disposable = (chatNs.onDidPerformAction as vscode.Event<unknown>)((action: unknown) => {
          this.handleChatAction(action)
        })
        this.disposables.push(disposable)
        log.info('Registered chat action listener')
      }
    } catch (err) {
      log.debug('Chat action API not available:', err)
    }

    // Watch for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentVisualizer.watchCopilotChat')) {
          const nowEnabled = vscode.workspace.getConfiguration('agentVisualizer').get<boolean>('watchCopilotChat', true)
          if (!nowEnabled && this.active) {
            log.info('Copilot Chat watching disabled')
            this.stop()
          }
        }
      }),
    )

    this.active = true
    log.info('Copilot Chat watcher started')
  }

  stop(): void {
    this.active = false
    // Mark active sessions as completed
    for (const [sessionId, session] of this.sessions) {
      if (!session.completed) {
        session.completed = true
        this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: session.label })
      }
    }
  }

  /** Create a new Copilot session and emit spawn events */
  createSession(label?: string): string {
    this.sessionCounter++
    const sessionId = `${COPILOT_SESSION_PREFIX}${Date.now()}-${this.sessionCounter}`
    const sessionLabel = label || `Copilot Chat #${this.sessionCounter}`

    const session: CopilotSession = {
      id: sessionId,
      label: sessionLabel,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      completed: false,
      toolCallCounter: 0,
    }

    this.sessions.set(sessionId, session)
    this._onSessionDetected.fire(sessionId)
    this._onSessionLifecycle.fire({ type: 'started', sessionId, label: sessionLabel })

    // Emit agent spawn for the Copilot orchestrator
    this._onEvent.fire({
      time: 0,
      type: 'agent_spawn',
      payload: { name: COPILOT_AGENT_NAME, task: sessionLabel },
      sessionId,
    })

    log.info(`Session created: ${sessionId} (${sessionLabel})`)
    return sessionId
  }

  /** Emit a tool call start event for the given session */
  emitToolCallStart(sessionId: string, toolName: string, args?: Record<string, unknown>): string {
    const session = this.sessions.get(sessionId)
    if (!session) return ''

    session.toolCallCounter++
    session.lastActivityTime = Date.now()
    const toolCallId = `copilot-tool-${session.toolCallCounter}`

    this._onEvent.fire({
      time: Date.now() - session.startTime,
      type: 'tool_call_start',
      payload: {
        agent: COPILOT_AGENT_NAME,
        tool: toolName,
        toolCallId,
        args: args ? JSON.stringify(args).slice(0, 200) : '',
        preview: toolName,
      },
      sessionId,
    })

    return toolCallId
  }

  /** Emit a tool call end event for the given session */
  emitToolCallEnd(sessionId: string, toolCallId: string, toolName: string, result?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.lastActivityTime = Date.now()

    this._onEvent.fire({
      time: Date.now() - session.startTime,
      type: 'tool_call_end',
      payload: {
        agent: COPILOT_AGENT_NAME,
        tool: toolName,
        toolCallId,
        result: result?.slice(0, 200) || '',
      },
      sessionId,
    })
  }

  /** Emit a message event (user or assistant) */
  emitMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.lastActivityTime = Date.now()

    this._onEvent.fire({
      time: Date.now() - session.startTime,
      type: 'message',
      payload: {
        agent: COPILOT_AGENT_NAME,
        role,
        content: content.slice(0, 2000),
      },
      sessionId,
    })
  }

  /** Emit a model detection event */
  emitModelDetected(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this._onEvent.fire({
      time: Date.now() - session.startTime,
      type: 'model_detected',
      payload: { model },
      sessionId,
    })
  }

  /** Mark a session as completed */
  completeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.completed) return

    session.completed = true
    session.lastActivityTime = Date.now()

    this._onEvent.fire({
      time: Date.now() - session.startTime,
      type: 'agent_complete',
      payload: { name: COPILOT_AGENT_NAME, sessionEnd: true },
      sessionId,
    })

    this._onSessionLifecycle.fire({ type: 'ended', sessionId, label: session.label })
    log.info(`Session completed: ${sessionId}`)
  }

  private handleChatAction(action: unknown): void {
    // Chat actions indicate Copilot is doing something — create/update session
    const kind = (action as Record<string, unknown>)?.kind
    log.debug('Chat action received:', kind)
  }

  /** Replay session start events for a newly connected webview */
  replaySessionStart(sessionIds?: string[]): void {
    for (const [sessionId, session] of this.sessions) {
      if (sessionIds && !sessionIds.includes(sessionId)) continue
      if (session.completed) continue

      this._onEvent.fire({
        time: 0,
        type: 'agent_spawn',
        payload: { name: COPILOT_AGENT_NAME, task: session.label },
        sessionId,
      })
    }
  }

  dispose(): void {
    this.stop()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}

interface CopilotSession {
  id: string
  label: string
  startTime: number
  lastActivityTime: number
  completed: boolean
  toolCallCounter: number
}
