/**
 * Runtime abstraction for agent session watchers.
 *
 * Each supported agent tool (Claude Code, Codex, ...) implements
 * AgentSessionWatcher and is started via a runtime factory in extension.ts.
 * The interface deliberately matches what the visualizer needs to render
 * live activity: an event stream, session lifecycle, and replay on panel
 * open. Runtime-specific concerns (hook servers, SQLite lookups, etc.)
 * live inside each runtime's startXxxRuntime() factory, not here.
 */

import * as vscode from 'vscode'
import type { AgentEvent, SessionInfo } from './protocol'

export type AgentRuntimeMode = 'claude' | 'codex'

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

/** A running runtime: its watcher, a status line describing its connection,
 *  and a disposer for runtime-specific resources beyond the watcher itself
 *  (e.g. the Claude hook server and discovery file). */
export interface AgentRuntime {
  readonly mode: AgentRuntimeMode
  readonly watcher: AgentSessionWatcher
  /** Human-readable connection status for the webview. May change over time. */
  connectionStatus(): string
  dispose(): void
}
