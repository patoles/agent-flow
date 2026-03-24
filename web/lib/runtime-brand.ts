export type AssistantBrandLabel = 'CLAUDE' | 'CODEX'

export function getAssistantBrandLabel(source?: string | null): AssistantBrandLabel {
  const normalized = source?.trim().toLowerCase() ?? ''
  if (normalized.includes('codex')) return 'CODEX'
  return 'CLAUDE'
}

export function getMessageRoleLabel(role: string, assistantLabel: AssistantBrandLabel): string {
  if (role === 'assistant') return assistantLabel
  if (role === 'thinking') return 'THINKING'
  return 'USER'
}
