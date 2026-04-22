import * as vscode from 'vscode'
import { VisualizerPanel } from './webview-provider'
import { JsonlEventSource } from './event-source'
import { WebviewToExtensionMessage } from './protocol'
import { startClaudeRuntime } from './claude-runtime'
import { promptHookSetupIfNeeded, configureClaudeHooks, isDisable1MContext } from './hooks-config'
import { createLogger } from './logger'
import type { AgentRuntime, AgentRuntimeMode } from './session-runtime'

const log = createLogger('Extension')

let eventSource: JsonlEventSource | undefined
let runtime: AgentRuntime | undefined

async function startRuntime(
  mode: AgentRuntimeMode,
  context: vscode.ExtensionContext,
): Promise<AgentRuntime> {
  switch (mode) {
    case 'claude':
      return startClaudeRuntime(context)
    case 'codex':
      throw new Error('Codex runtime not yet implemented')
  }
}

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activated')

  runtime = await startRuntime('claude', context)

  // ─── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.open', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.One)
      wirePanel(panel)
      promptHookSetupIfNeeded(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.openToSide', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.Beside)
      wirePanel(panel)
      promptHookSetupIfNeeded(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.connectToAgent', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(radio-tower) Claude Code Hooks', description: 'Auto-configure hooks for live streaming', value: 'hooks' },
          { label: '$(file) Watch JSONL File', description: 'Watch a file for agent events', value: 'jsonl' },
          { label: '$(play) Mock Data', description: 'Use built-in demo scenario', value: 'mock' },
        ],
        { placeHolder: 'Select event source' },
      )

      if (!choice) { return }

      if (choice.value === 'hooks') {
        await configureClaudeHooks()
      } else if (choice.value === 'jsonl') {
        const fileUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSONL Files': ['jsonl', 'json', 'ndjson'] },
          title: 'Select agent event log file',
        })

        if (fileUri?.[0]) {
          connectToJsonl(fileUri[0].fsPath, context)
        }
      } else if (choice.value === 'mock') {
        const panel = VisualizerPanel.getCurrent()
        if (panel) {
          panel.postMessage({ type: 'config', config: { mode: 'replay', autoPlay: true, showMockData: true } })
        }
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.configureHooks', async () => {
      await configureClaudeHooks()
    }),
  )

  // ─── Serializer (restore panel on VS Code restart) ─────────────────────────

  vscode.window.registerWebviewPanelSerializer(VisualizerPanel.viewType, {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
      const panel = VisualizerPanel.revive(webviewPanel, context.extensionUri)
      wirePanel(panel)
    },
  })
}

function wirePanel(panel: VisualizerPanel): void {
  if (panel.isWired) { return }
  panel.markWired()
  let readyHandled = false
  panel.onCommand((message: WebviewToExtensionMessage) => {
    switch (message.type) {
      case 'ready':
        if (readyHandled) { return }
        readyHandled = true
        log.info('Webview ready')
        // Allow events to flow before replay — replay emits through the
        // same onEvent listener, and it's synchronous so no live events
        // can interleave. Events before this point were gated (dropped),
        // and replayExistingContent covers them from the JSONL file.
        panel.markReady()
        // Clear stale webview state from any previous panel instance
        panel.postMessage({ type: 'reset', reason: 'panel-reopened' })
        // Send environment-derived config (e.g. CLAUDE_CODE_DISABLE_1M_CONTEXT)
        if (isDisable1MContext()) {
          panel.postMessage({ type: 'config', config: { disable1MContext: true } })
        }
        // Report current connection status and replay active sessions
        if (runtime) {
          // Send session list FIRST so the webview selects a session
          // before replay events arrive (otherwise they have no selected
          // session to match and are only buffered, not delivered).
          const sessions = runtime.watcher.getActiveSessions()
          if (sessions.length > 0) {
            panel.postMessage({ type: 'session-list', sessions })
            runtime.watcher.replaySessionStart(sessions.map(s => s.id))
          }
          panel.setConnectionStatus('watching', runtime.connectionStatus())
        }
        break

      case 'request-connect':
        vscode.commands.executeCommand('agentVisualizer.connectToAgent')
        break

      case 'request-disconnect':
        disconnectEventSource()
        panel.setConnectionStatus('disconnected', '')
        break

      case 'open-file':
        handleOpenFile(message.filePath, message.line)
        break

      case 'log': {
        const webviewLog = createLogger('Webview')
        const logFn = message.level === 'error' ? webviewLog.error
          : message.level === 'warn' ? webviewLog.warn
          : webviewLog.info
        logFn(message.message)
        break
      }
    }
  })
}

// ─── JSONL Connection ──────────────────────────────────────────────────────

function connectToJsonl(filePath: string, context: vscode.ExtensionContext): void {
  disconnectEventSource()

  eventSource = new JsonlEventSource(filePath)
  context.subscriptions.push(eventSource)

  const panel = VisualizerPanel.getCurrent()
  if (!panel) { return }

  eventSource.onEvent((event) => {
    panel.sendEvent(event)
  })

  eventSource.onStatus((status) => {
    panel.setConnectionStatus(
      status === 'connected' ? 'watching' : 'disconnected',
      filePath,
    )
  })

  eventSource.start()
}

function disconnectEventSource(): void {
  if (eventSource) {
    eventSource.dispose()
    eventSource = undefined
  }
}

// ─── File Handlers ────────────────────────────────────────────────────────

async function handleOpenFile(filePath: string, line?: number): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    })
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }
  } catch (err) {
    log.error(`Failed to open file: ${filePath}`, err)
  }
}

export function deactivate(): void {
  disconnectEventSource()
  if (runtime) {
    runtime.dispose()
    runtime = undefined
  }
}
