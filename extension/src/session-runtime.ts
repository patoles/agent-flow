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
import { VisualizerPanel } from './webview-provider'
import { SESSION_ID_DISPLAY, STATUS_MESSAGE_DURATION_MS } from './constants'
import type { TypedDisposable, TypedEvent } from './typed-event-emitter'

export type AgentRuntimeMode = 'claude' | 'codex'

export interface SessionLifecycleEvent {
  type: 'started' | 'ended' | 'updated'
  sessionId: string
  label: string
}

/** Interface every runtime's watcher implements. Uses portable typed-event
 *  types (not vscode.Event) so watchers can run in the relay/CLI too. */
export interface AgentSessionWatcher extends TypedDisposable {
  readonly onEvent: TypedEvent<AgentEvent>
  readonly onSessionDetected: TypedEvent<string>
  readonly onSessionLifecycle: TypedEvent<SessionLifecycleEvent>
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

/** Options for the default watcher → panel wiring. */
export interface WatchPanelWiringOptions {
  /** Human-readable prefix for the session badge (e.g. "Claude", "Codex"). */
  sessionLabelPrefix: string
  /** Optional event transform — return null to suppress an event. */
  transformEvent?: (event: AgentEvent) => AgentEvent | null
}

/**
 * Wire a watcher's event/lifecycle streams to the current visualizer panel.
 * This is the boilerplate every runtime needs: forward events, broadcast
 * session list changes, and reflect session detection in the status bar.
 *
 * Returns a disposable that unhooks all three listeners — callers wiring the
 * watcher multiple times (e.g. re-wiring on panel reopen) should dispose the
 * previous wiring to avoid accumulating listeners.
 */
export function wireWatcherToPanel(
  watcher: AgentSessionWatcher,
  options: WatchPanelWiringOptions,
): TypedDisposable {
  const subs: TypedDisposable[] = []

  subs.push(watcher.onEvent((event) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel || !panel.isReady) return
    const transformed = options.transformEvent ? options.transformEvent(event) : event
    if (transformed) panel.sendEvent(transformed)
  }))

  subs.push(watcher.onSessionDetected((sessionId) => {
    const panel = VisualizerPanel.getCurrent()
    if (panel) {
      const sessionCount = watcher.getActiveSessions().length
      panel.setConnectionStatus('watching', sessionCount > 1
        ? `${sessionCount} ${options.sessionLabelPrefix} sessions`
        : `${options.sessionLabelPrefix} ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    }
    vscode.window.setStatusBarMessage(
      `Agent Visualizer: watching ${options.sessionLabelPrefix} session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      STATUS_MESSAGE_DURATION_MS,
    )
  }))

  subs.push(watcher.onSessionLifecycle((lifecycle) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel) return
    if (lifecycle.type === 'started') {
      panel.postMessage({
        type: 'session-started',
        session: {
          id: lifecycle.sessionId,
          label: lifecycle.label,
          status: 'active',
          startTime: Date.now(),
          lastActivityTime: Date.now(),
        },
      })
    } else if (lifecycle.type === 'updated') {
      panel.postMessage({ type: 'session-updated', sessionId: lifecycle.sessionId, label: lifecycle.label })
    } else {
      panel.postMessage({ type: 'session-ended', sessionId: lifecycle.sessionId })
    }
  }))

  return { dispose: () => { for (const s of subs) s.dispose() } }
}
