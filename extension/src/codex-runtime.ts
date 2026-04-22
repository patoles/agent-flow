/**
 * Codex runtime.
 *
 * Codex has no hook mechanism (unlike Claude Code) — its only event source is
 * the rollout JSONL file. This runtime wires CodexSessionWatcher to the
 * visualizer panel and reports a connection status reflecting the watch root.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { VisualizerPanel } from './webview-provider'
import { SESSION_ID_DISPLAY, STATUS_MESSAGE_DURATION_MS } from './constants'
import { CodexSessionWatcher } from './codex-session-watcher'
import { createLogger } from './logger'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('CodexRuntime')

export function startCodexRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const watcher = new CodexSessionWatcher()
  context.subscriptions.push(watcher)

  watcher.onEvent((event) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel || !panel.isReady) return
    panel.sendEvent(event)
  })

  watcher.onSessionDetected((sessionId) => {
    const panel = VisualizerPanel.getCurrent()
    if (panel) {
      const sessionCount = watcher.getActiveSessions().length
      panel.setConnectionStatus('watching', sessionCount > 1
        ? `${sessionCount} Codex sessions`
        : `Codex ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    }
    vscode.window.setStatusBarMessage(
      `Agent Visualizer: watching Codex session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      STATUS_MESSAGE_DURATION_MS,
    )
  })

  watcher.onSessionLifecycle((lifecycle) => {
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
  })

  watcher.start()

  const homeLabel = process.env.CODEX_HOME
    ? process.env.CODEX_HOME.replace(os.homedir(), '~')
    : '~/.codex'

  const connectionStatus = (): string => `Codex session watcher (${homeLabel})`

  const dispose = (): void => watcher.dispose()

  log.info(`Codex runtime started (home: ${homeLabel})`)

  return { mode: 'codex', watcher, connectionStatus, dispose }
}
