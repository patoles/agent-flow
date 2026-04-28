import type { Agent } from './agent-types'

export function getAgentRuntimeLabel(runtime?: Agent['runtime']): string {
  return runtime === 'codex' ? 'CODEX' : 'CLAUDE'
}

export function getMessageSenderLabel(type: string, runtime?: Agent['runtime']): string {
  if (type === 'user') return 'USER'
  if (type === 'thinking') return 'THINKING'
  if (type === 'assistant') return getAgentRuntimeLabel(runtime)
  return 'TOOL'
}
