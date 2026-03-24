import * as vscode from 'vscode'
import { AgentEvent, SessionInfo } from './protocol'

export type AgentRuntimeMode = 'claude' | 'codex'
export type ConfiguredRuntimeMode = AgentRuntimeMode | 'auto'

export interface SessionLifecycleEvent {
  type: 'started' | 'ended' | 'updated'
  sessionId: string
  label: string
}

export interface AgentSessionWatcher extends vscode.Disposable {
  readonly onEvent: vscode.Event<AgentEvent>
  readonly onSessionDetected: vscode.Event<string>
  readonly onSessionLifecycle: vscode.Event<SessionLifecycleEvent>
  start(): void
  isActive(): boolean
  isSessionActive(sessionId: string): boolean
  getActiveSessions(): SessionInfo[]
  replaySessionStart(sessionIds?: string[]): void
}
