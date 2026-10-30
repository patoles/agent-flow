/**
 * Strands runtime.
 *
 * Strands agents emit agent-flow events via the AgentFlowHookProvider, which
 * writes native AgentEvent JSONL to ~/.strands/agent-flow/. This runtime wires
 * StrandsSessionWatcher to the visualizer panel.
 */

import * as vscode from 'vscode'
import * as os from 'os'
import { StrandsSessionWatcher } from './strands-session-watcher'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('StrandsRuntime')

export function startStrandsRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const watcher = new StrandsSessionWatcher(workspace)
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Strands',
  })

  watcher.start()

  const homeLabel = process.env.STRANDS_HOME
    ? process.env.STRANDS_HOME.replace(os.homedir(), '~')
    : '~/.strands'

  const connectionStatus = (): string => `Strands session watcher (${homeLabel}/agent-flow)`

  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Strands runtime started (home: ${homeLabel})`)

  return { mode: 'strands', watcher, connectionStatus, dispose }
}
