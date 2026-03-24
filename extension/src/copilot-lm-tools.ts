import * as vscode from 'vscode'
import { SessionInfo } from './protocol'
import { createLogger } from './logger'

const log = createLogger('LMTool')

/**
 * Registers the `agentFlow_getSessionStatus` language model tool.
 *
 * This lets GitHub Copilot invoke the tool during chat to query
 * Agent Flow session status — e.g., "what sessions are active?"
 *
 * Uses runtime access since the Language Model Tool API may not be
 * present in all @types/vscode versions.
 */
export function registerLanguageModelTools(
  _context: vscode.ExtensionContext,
  deps: {
    getActiveSessions: () => SessionInfo[]
    getHookPort: () => number
  },
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = []

  try {
    // Runtime check: vscode.lm.registerTool may not exist in older VS Code versions
    const lmNs = vscode.lm as Record<string, unknown>
    if (typeof lmNs.registerTool !== 'function') {
      log.debug('vscode.lm.registerTool not available in this VS Code version')
      return disposables
    }

    const registerTool = lmNs.registerTool as (name: string, impl: unknown) => vscode.Disposable

    const tool = registerTool('agentFlow_getSessionStatus', {
      async invoke(
        options: { input?: { sessionId?: string } },
        _token: vscode.CancellationToken,
      ) {
        const sessions = deps.getActiveSessions()
        const requestedId = options.input?.sessionId

        const result = requestedId
          ? sessions.find(s => s.id === requestedId || s.id.startsWith(requestedId))
            ?? { error: 'Session not found', sessionId: requestedId }
          : {
              hookServerPort: deps.getHookPort(),
              activeSessions: sessions.length,
              sessions: sessions.map(s => ({
                id: s.id,
                label: s.label,
                status: s.status,
                startTime: s.startTime,
                lastActivityTime: s.lastActivityTime,
                age: Math.round((Date.now() - s.startTime) / 1000),
              })),
            }

        // Construct result using runtime-available classes
        const ToolResult = (vscode as Record<string, unknown>).LanguageModelToolResult as
          new (parts: unknown[]) => unknown
        const TextPart = (vscode as Record<string, unknown>).LanguageModelTextPart as
          new (text: string) => unknown

        if (ToolResult && TextPart) {
          return new ToolResult([new TextPart(JSON.stringify(result))])
        }
        // Fallback: return plain object
        return { text: JSON.stringify(result) }
      },

      async prepareInvocation() {
        return { invocationMessage: 'Checking Agent Flow session status...' }
      },
    })

    disposables.push(tool)
    log.info('Language model tool registered: agentFlow_getSessionStatus')
  } catch (err) {
    log.debug('Language model tool API not available:', err)
  }

  return disposables
}
