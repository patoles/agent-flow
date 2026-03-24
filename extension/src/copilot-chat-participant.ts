import * as vscode from 'vscode'
import { createLogger } from './logger'
import type { CopilotWatcher } from './copilot-watcher'

const log = createLogger('CopilotChat')

const PARTICIPANT_ID = 'agent-flow.visualizer'
const MAX_TOOL_ROUNDS = 15

/** Deps injected from extension.ts */
export interface ChatParticipantDeps {
  getActiveSessions: () => Array<{ id: string; label: string; status: string; startTime: number; lastActivityTime: number }>
  getHookPort: () => number
  isSessionWatcherActive: () => boolean
  isCopilotWatcherActive: () => boolean
  copilotWatcher?: CopilotWatcher
}

/**
 * Registers an @agent-flow chat participant in GitHub Copilot Chat.
 *
 * Users can type @agent-flow in Copilot Chat to:
 *   /status   — Show current session status
 *   /open     — Open the visualizer panel
 *   /sessions — List active sessions
 *   (default) — Agentic proxy that visualizes every tool call on the canvas
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  deps: ChatParticipantDeps,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) => {
    const command = request.command

    if (command === 'open') {
      await vscode.commands.executeCommand('agentVisualizer.open')
      stream.markdown('Opened the **Agent Flow** visualizer panel.')
      return
    }

    if (command === 'sessions') {
      const sessions = deps.getActiveSessions()
      if (sessions.length === 0) {
        stream.markdown('No active agent sessions detected.\n\nTo start watching, open the visualizer with `/open` and begin an agent session.')
        return
      }
      stream.markdown(`**Active Sessions (${sessions.length}):**\n\n`)
      for (const s of sessions) {
        const age = Math.round((Date.now() - s.startTime) / 1000)
        stream.markdown(`- **${s.label || s.id.slice(0, 8)}** — ${s.status} (${age}s ago)\n`)
      }
      return
    }

    if (command === 'status') {
      return handleStatus(stream, deps)
    }

    // Default: agentic proxy with real-time visualization
    await handleAgenticProxy(request, chatContext, stream, token, deps.copilotWatcher)
  })

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')

  log.info('Chat participant registered')
  return participant
}

// ─── Agentic proxy ────────────────────────────────────────────────────────────

// Runtime references to VS Code LM classes (available in VS Code 1.95+).
// The extension targets @types/vscode 1.93, so these don't exist in the typings.
// Resolved lazily (inside functions) — at module load time the API may not exist yet.
/* eslint-disable @typescript-eslint/no-explicit-any */
function getLMTextPart(): (new (text: string) => any) | undefined {
  return (vscode as any).LanguageModelTextPart
}
function getLMToolResultPart(): (new (callId: string, content: any) => any) | undefined {
  return (vscode as any).LanguageModelToolResultPart
}
function getLmNs(): any {
  return vscode.lm as any
}

function hasToolSupport(): boolean {
  const lm = getLmNs()
  return typeof lm?.tools !== 'undefined'
    && typeof lm?.invokeTool === 'function'
    && !!getLMTextPart()
    && !!getLMToolResultPart()
}

/**
 * Forward the user's prompt to the language model with full tool access.
 * Each tool call is emitted as a visualization event on the Agent Flow canvas.
 */
async function handleAgenticProxy(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  watcher?: CopilotWatcher,
): Promise<void> {
  // ── 0. Check runtime API availability ──────────────────────────────────
  log.info(`Tool support check: lm.tools=${typeof getLmNs()?.tools}, invokeTool=${typeof getLmNs()?.invokeTool}, TextPart=${!!getLMTextPart()}, ResultPart=${!!getLMToolResultPart()}`)

  if (!hasToolSupport()) {
    log.warn('Tool API not available — falling back to non-agentic mode')
    stream.markdown(
      '**Agent Flow agentic mode** requires VS Code 1.95+ with tool API support.\n\n' +
      'Your VS Code may not expose `vscode.lm.tools`. Try updating VS Code Insiders.\n\n' +
      'Available commands: `/status`, `/open`, `/sessions`\n\n' +
      'Alternatively, use Claude Code hooks for real-time visualization.',
    )
    return
  }

  // ── 1. Select a language model ─────────────────────────────────────────
  let model: vscode.LanguageModelChat | undefined

  // Prefer the model attached to the request (VS Code 1.95+)
  try {
    const reqModel = (request as any).model as vscode.LanguageModelChat | undefined
    if (reqModel && typeof reqModel.sendRequest === 'function') {
      model = reqModel
    }
  } catch { /* not available */ }

  if (!model) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' })
    model = models[0]
  }

  if (!model) {
    stream.markdown('No language model available. Make sure GitHub Copilot is signed in.')
    return
  }

  // ── 2. Ensure visualizer panel is open ─────────────────────────────────
  await vscode.commands.executeCommand('agentVisualizer.open')

  // ── 3. Create a visualization session ──────────────────────────────────
  const sessionLabel = request.prompt.length > 60
    ? request.prompt.slice(0, 57) + '...'
    : request.prompt
  const sessionId = watcher?.createSession(sessionLabel) ?? ''

  if (watcher && sessionId) {
    watcher.emitModelDetected(sessionId, (model as any).name ?? (model as any).id ?? 'unknown')
    watcher.emitMessage(sessionId, 'user', request.prompt)
  }

  // ── 4. Build conversation from chat history ────────────────────────────
  const messages: vscode.LanguageModelChatMessage[] = []

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt))
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const parts = turn.response
        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
      const text = parts.join('')
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text))
      }
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(request.prompt))

  // ── 5. Gather available tools ──────────────────────────────────────────
  const lm = getLmNs()
  const tools: any[] = lm.tools ?? []
  const LMTextPart = getLMTextPart()
  const LMToolResultPart = getLMToolResultPart()

  // ── 6. Agentic loop ────────────────────────────────────────────────────
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (token.isCancellationRequested) break

      const response: any = await model.sendRequest(messages, { tools } as any, token)

      let textAccumulator = ''
      const toolCalls: any[] = []

      // response.stream (1.95+) or response.text (1.93) — prefer stream
      const responseStream: AsyncIterable<any> = response.stream ?? response.text
      for await (const part of responseStream) {
        if (LMTextPart && part instanceof LMTextPart) {
          stream.markdown(part.value)
          textAccumulator += part.value
        } else if (typeof part === 'string') {
          // Fallback for older response.text iteration
          stream.markdown(part)
          textAccumulator += part
        } else if (part?.callId || part?.name) {
          // LanguageModelToolCallPart — has callId + name + input
          toolCalls.push(part)
        }
      }

      // Emit assistant message to visualizer
      if (textAccumulator && watcher && sessionId) {
        watcher.emitMessage(sessionId, 'assistant', textAccumulator)
      }

      // No tool calls → model is done
      if (toolCalls.length === 0) break

      // Record the assistant turn (text + tool call requests)
      const assistantParts: any[] = []
      if (textAccumulator && LMTextPart) {
        assistantParts.push(new LMTextPart(textAccumulator))
      }
      assistantParts.push(...toolCalls)
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts as any))

      // ── Execute each tool call ───────────────────────────────────────
      for (const toolCall of toolCalls) {
        if (token.isCancellationRequested) break

        const toolCallId = watcher?.emitToolCallStart(
          sessionId, toolCall.name, toolCall.input as Record<string, unknown>,
        ) ?? ''

        stream.progress(`Running ${toolCall.name}…`)

        try {
          const invokeTool = lm.invokeTool as (name: string, opts: any, token: any) => Promise<any>
          const result = await invokeTool(toolCall.name, {
            input: toolCall.input,
            toolInvocationToken: (request as any).toolInvocationToken,
          }, token)

          // Summarize result for the visualizer (keep it short)
          let resultSummary = ''
          if (result?.content && Array.isArray(result.content)) {
            resultSummary = result.content
              .filter((p: any) => typeof p?.value === 'string')
              .map((p: any) => p.value)
              .join('')
              .slice(0, 200)
          }

          if (watcher && sessionId) {
            watcher.emitToolCallEnd(sessionId, toolCallId, toolCall.name, resultSummary)
          }

          // Feed result back to the model
          if (LMToolResultPart) {
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new LMToolResultPart(toolCall.callId, result?.content ?? []),
              ] as any),
            )
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          log.warn(`Tool ${toolCall.name} failed:`, errMsg)

          if (watcher && sessionId) {
            watcher.emitToolCallEnd(sessionId, toolCallId, toolCall.name, `Error: ${errMsg}`)
          }

          if (LMToolResultPart && LMTextPart) {
            messages.push(
              vscode.LanguageModelChatMessage.User([
                new LMToolResultPart(toolCall.callId, [
                  new LMTextPart(`Error invoking ${toolCall.name}: ${errMsg}`),
                ]),
              ] as any),
            )
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof vscode.CancellationError) {
      log.info('Request cancelled')
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('Agentic proxy error:', errMsg)
      stream.markdown(`\n\n*Error: ${errMsg}*`)
    }
  } finally {
    if (watcher && sessionId) {
      watcher.completeSession(sessionId)
    }
  }
}

// ─── Status handler ───────────────────────────────────────────────────────────

function handleStatus(
  stream: vscode.ChatResponseStream,
  deps: ChatParticipantDeps,
): void {
  const sessions = deps.getActiveSessions()
  const hookPort = deps.getHookPort()
  const sessionWatcherActive = deps.isSessionWatcherActive()
  const copilotWatcherActive = deps.isCopilotWatcherActive()

  const sources: string[] = []
  if (hookPort > 0) sources.push(`Claude Code hooks (port ${hookPort})`)
  if (sessionWatcherActive) sources.push('Claude Code session watcher')
  if (copilotWatcherActive) sources.push('Copilot Chat watcher')

  stream.markdown('**Agent Flow Status**\n\n')
  stream.markdown(`**Event Sources:** ${sources.length > 0 ? sources.join(', ') : 'None active'}\n\n`)
  stream.markdown(`**Active Sessions:** ${sessions.length}\n`)
  if (sessions.length > 0) {
    for (const s of sessions) {
      stream.markdown(`- ${s.label || s.id.slice(0, 8)} (${s.status})\n`)
    }
  }
}
