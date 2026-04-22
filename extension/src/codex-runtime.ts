/**
 * Codex runtime.
 *
 * Codex has no hook mechanism (unlike Claude Code) — its only event source is
 * the rollout JSONL file. This runtime wires CodexSessionWatcher to the
 * visualizer panel and reports a connection status reflecting the watch root.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { CodexSessionWatcher } from './codex-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('CodexRuntime')

export function startCodexRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new CodexSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Codex',
  })

  watcher.start()

  const homeLabel = process.env.CODEX_HOME
    ? process.env.CODEX_HOME.replace(os.homedir(), '~')
    : '~/.codex'

  const connectionStatus = (): string => `Codex session watcher (${homeLabel})`

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Codex runtime started (home: ${homeLabel})`)

  return { mode: 'codex', watcher, connectionStatus, dispose }
}
