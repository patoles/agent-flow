import * as vscode from 'vscode'
import { VisualizerPanel } from './webview-provider'
import { JsonlEventSource } from './event-source'
import { HookServer } from './hook-server'
import { SessionWatcher } from './session-watcher'
import { AgentEvent, WebviewToExtensionMessage } from './protocol'
import { CodexSessionWatcher } from './codex-session-watcher'
import {
  ORCHESTRATOR_NAME, HOOK_SERVER_NOT_STARTED,
  SESSION_ID_DISPLAY, STATUS_MESSAGE_DURATION_MS,
} from './constants'
import {
  promptHookSetupIfNeeded,
  configureClaudeHooks, migrateHttpHooks,
} from './hooks-config'
import {
  writeDiscoveryFile, removeDiscoveryFile,
  ensureHookScript,
} from './discovery'
import { createLogger } from './logger'
import type { AgentRuntimeMode, AgentSessionWatcher } from './session-runtime'

const log = createLogger('Extension')

/** Convert orchestrator agent_complete to agent_idle unless it's a session end.
 *  Prevents premature "completed" state during long API calls. */
function filterOrchestratorCompletion(event: AgentEvent): AgentEvent | null {
  if (event.type !== 'agent_complete') return event
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (!isOrchestrator) return event
  if (event.payload?.sessionEnd) return event
  return { ...event, type: 'agent_idle' }
}

let eventSource: JsonlEventSource | undefined
let hookServer: HookServer | undefined
let sessionWatcher: AgentSessionWatcher | undefined
let activeRuntime: AgentRuntimeMode = 'claude'

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activated')

  await startRuntime(context)

  // ─── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.open', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.One)
      wirePanel(panel)
      if (activeRuntime === 'claude') {
        promptHookSetupIfNeeded(context)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.openToSide', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.Beside)
      wirePanel(panel)
      if (activeRuntime === 'claude') {
        promptHookSetupIfNeeded(context)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.connectToAgent', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(radio-tower) Claude Code', description: 'Use Claude transcripts and optional hooks', value: 'claude' },
          { label: '$(sparkle) Codex Sessions', description: 'Watch local Codex rollout sessions', value: 'codex' },
          { label: '$(file) Watch JSONL File', description: 'Watch a file for agent events', value: 'jsonl' },
          { label: '$(play) Mock Data', description: 'Use built-in demo scenario', value: 'mock' },
        ],
        { placeHolder: 'Select agent runtime or event source' },
      )

      if (!choice) { return }

      if (choice.value === 'claude') {
        await switchRuntimeMode(context, 'claude', true)
      } else if (choice.value === 'codex') {
        await switchRuntimeMode(context, 'codex')
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
      if (activeRuntime !== 'claude') {
        await switchRuntimeMode(context, 'claude')
      }
      await configureClaudeHooks()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.selectRuntime', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Claude Code', value: 'claude' as const },
          { label: 'Codex', value: 'codex' as const },
        ],
        { placeHolder: 'Select the runtime Agent Flow should watch' },
      )
      if (!choice) return
      await switchRuntimeMode(context, choice.value)
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

function resolveRuntimeMode(): AgentRuntimeMode {
  const configured = vscode.workspace.getConfiguration('agentVisualizer').get<string>('runtime', 'claude')
  return configured === 'codex' ? 'codex' : 'claude'
}

function currentConnectionSource(): string {
  if (activeRuntime === 'claude') {
    if (hookServer && hookServer.getPort() > 0) {
      return `Claude hooks :${hookServer.getPort()} + session watcher`
    }
    return 'Claude session watcher'
  }
  return 'Codex session watcher'
}

function wireSessionWatcherEvents(): void {
  if (!sessionWatcher) return

  sessionWatcher.onEvent((event) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel || !panel.isReady) { return }

    const filtered = filterOrchestratorCompletion(event)
    if (filtered) panel.sendEvent(filtered)
  })

  sessionWatcher.onSessionDetected((sessionId) => {
    const panel = VisualizerPanel.getCurrent()
    if (panel) {
      const sessionCount = sessionWatcher?.getActiveSessions().length ?? 0
      panel.setConnectionStatus('watching', sessionCount > 1
        ? `${sessionCount} ${activeRuntime} sessions`
        : `${activeRuntime} ${sessionId.slice(0, SESSION_ID_DISPLAY)}`)
    }
    vscode.window.setStatusBarMessage(
      `Agent Visualizer: watching ${activeRuntime} session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      STATUS_MESSAGE_DURATION_MS,
    )
  })

  sessionWatcher.onSessionLifecycle((lifecycle) => {
    const panel = VisualizerPanel.getCurrent()
    if (!panel) { return }
    if (lifecycle.type === 'started') {
      panel.postMessage({
        type: 'session-started',
        session: {
          id: lifecycle.sessionId,
          label: lifecycle.label,
          status: 'active' as const,
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
}

async function startClaudeRuntime(context: vscode.ExtensionContext): Promise<void> {
  activeRuntime = 'claude'

  hookServer = new HookServer()
  context.subscriptions.push(hookServer)

  let hookPort: number
  try {
    hookPort = await hookServer.start()
  } catch (err) {
    log.error('Failed to start hook server:', err)
    hookPort = HOOK_SERVER_NOT_STARTED
  }

  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    log.info('Hook server skipped (another instance owns the port) — using session watcher only')
  } else {
    log.info(`Hook server running on port ${hookPort}`)

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspace) {
      ensureHookScript()
      writeDiscoveryFile(hookPort, workspace)
      migrateHttpHooks()
    }

    hookServer.onEvent((event) => {
      const panel = VisualizerPanel.getCurrent()
      if (!panel || !panel.isReady) { return }

      const eventSessionId = event.sessionId
      const sessionWatcherHandlesThis = eventSessionId
        ? sessionWatcher?.isSessionActive(eventSessionId)
        : sessionWatcher?.isActive()

      if (sessionWatcherHandlesThis) {
        const agentName = event.payload?.agent ?? event.payload?.name
        const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName

        if (isOrchestrator) {
          const filtered = filterOrchestratorCompletion(event)
          if (filtered) panel.sendEvent(filtered)
          return
        }

        const subagentLifecycleEvents = ['agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete']
        if (subagentLifecycleEvents.includes(event.type)) return

        panel.sendEvent(event)
        return
      }

      panel.sendEvent(event)
      panel.setConnectionStatus('watching', `Claude hooks (:${hookPort})`)
    })
  }

  sessionWatcher = new SessionWatcher()
  context.subscriptions.push(sessionWatcher)
  wireSessionWatcherEvents()
  sessionWatcher.start()
}

function startCodexRuntime(context: vscode.ExtensionContext): void {
  activeRuntime = 'codex'
  sessionWatcher = new CodexSessionWatcher()
  context.subscriptions.push(sessionWatcher)
  wireSessionWatcherEvents()
  sessionWatcher.start()
}

async function startRuntime(context: vscode.ExtensionContext): Promise<void> {
  const runtime = resolveRuntimeMode()
  if (runtime === 'codex') {
    startCodexRuntime(context)
  } else {
    await startClaudeRuntime(context)
  }
}

function disposeRuntime(): void {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspace) {
    removeDiscoveryFile(workspace)
  }

  if (hookServer) {
    hookServer.dispose()
    hookServer = undefined
  }
  if (sessionWatcher) {
    sessionWatcher.dispose()
    sessionWatcher = undefined
  }
}

async function restartRuntime(context: vscode.ExtensionContext): Promise<void> {
  disposeRuntime()
  await startRuntime(context)

  const panel = VisualizerPanel.getCurrent()
  if (!panel || !panel.isReady) return

  panel.postMessage({ type: 'reset', reason: 'runtime-switched' })
  const sessions = sessionWatcher?.getActiveSessions() ?? []
  if (sessions.length > 0) {
    panel.postMessage({ type: 'session-list', sessions })
    sessionWatcher?.replaySessionStart(sessions.map((session) => session.id))
  }
  panel.setConnectionStatus('watching', currentConnectionSource())
}

async function switchRuntimeMode(
  context: vscode.ExtensionContext,
  mode: AgentRuntimeMode,
  configureHooksAfter = false,
): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  await vscode.workspace.getConfiguration('agentVisualizer').update('runtime', mode, target)
  await restartRuntime(context)

  if (mode === 'claude' && configureHooksAfter) {
    await configureClaudeHooks()
  } else if (mode === 'codex') {
    vscode.window.setStatusBarMessage('Agent Flow: watching Codex sessions', STATUS_MESSAGE_DURATION_MS)
  }
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
        // Report current connection status and replay active sessions
        if (sessionWatcher) {
          // Send session list FIRST so the webview selects a session
          // before replay events arrive (otherwise they have no selected
          // session to match and are only buffered, not delivered).
          const sessions = sessionWatcher.getActiveSessions()
          if (sessions.length > 0) {
            panel.postMessage({ type: 'session-list', sessions })
            sessionWatcher.replaySessionStart(sessions.map(s => s.id))
          }
        }
        panel.setConnectionStatus('watching', currentConnectionSource())
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
  disposeRuntime()
}
