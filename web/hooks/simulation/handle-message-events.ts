import type { ContextBreakdown } from '@/lib/agent-types'
import type { ConversationMessage } from './types'
import { appendConversation, asString, asNumber, LABEL_LEN_NAME, LABEL_LEN_TASK, LABEL_LEN_BUBBLE, MAX_BUBBLES } from './types'
import type { MutableEventState, ProcessEventContext } from './process-event'
import { pushTimelineBlock } from './process-event'
import { COLORS } from '@/lib/colors'
import { formatTokens } from '@/lib/utils'

export function handleMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const content = asString(payload.content)
  const role = typeof payload.role === 'string' ? payload.role : undefined

  // Map role to conversation message type
  const msgType: ConversationMessage['type'] =
    role === 'user' ? 'user' :
    role === 'thinking' ? 'thinking' :
    'assistant'

  // Rename main agent to the first user message (more recognizable than "orchestrator")
  if (role === 'user') {
    const msgAgentForName = state.agents.get(agentName)
    if (msgAgentForName && msgAgentForName.isMain && msgAgentForName.name === agentName) {
      const shortName = content.slice(0, LABEL_LEN_NAME).replace(/\n/g, ' ').trim()
      state.agents.set(agentName, { ...msgAgentForName, name: shortName || agentName, task: content.slice(0, LABEL_LEN_TASK) })
    }
  }

  // Update agent state and push message bubble to queue
  const msgAgent = state.agents.get(agentName)
  if (msgAgent) {
    const bubbleRole: 'user' | 'thinking' | 'assistant' = role === 'user' ? 'user' : role === 'thinking' ? 'thinking' : 'assistant'
    const updates: Partial<typeof msgAgent> = {}

    {
      // Truncate thinking for graph bubbles (full text in message feed panel)
      const bubbleText = bubbleRole === 'thinking' ? content.slice(0, LABEL_LEN_BUBBLE) + (content.length > LABEL_LEN_BUBBLE ? '...' : '') : content
      // Dedup: skip if last bubble has the same text (dual event source race)
      const lastBubble = msgAgent.messageBubbles[msgAgent.messageBubbles.length - 1]
      if (!lastBubble || lastBubble.text !== bubbleText) {
        const newBubbles = [...msgAgent.messageBubbles, { text: bubbleText, time: currentTime, role: bubbleRole }]
        updates.messageBubbles = newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles
      }
    }

    if (msgAgent.state !== 'complete' && msgAgent.state !== 'tool_calling') {
      if (role === 'user' || role === 'thinking' || role === 'assistant') {
        updates.state = 'thinking'
      }
    }
    if (Object.keys(updates).length > 0) {
      state.agents.set(agentName, { ...msgAgent, ...updates })
    }
  }

  appendConversation(state.conversations, agentName, { type: msgType, content, timestamp: currentTime })
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const tokens = asNumber(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  const agent = state.agents.get(agentName)
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      tokensUsed: tokens,
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      state: agent.state === 'complete' ? 'complete' : 'thinking'
    })
  }
}

/** Context compaction: the boss died, a relic (the summary) drops. Marks the timeline and leaves the relic in the transcript. */
export function handleContextCompacted(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const before = asNumber(payload.before)
  const after = asNumber(payload.after)
  const relic = asString(payload.relic)
  const agent = state.agents.get(agentName)
  if (agent) {
    const bubble = { text: `⟲ Context compacted: ${formatTokens(before)} → ${formatTokens(after)}`, time: currentTime, role: 'assistant' as const }
    const newBubbles = [...agent.messageBubbles, bubble]
    state.agents.set(agentName, { ...agent, messageBubbles: newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles })
  }
  const entry = state.timelineEntries.get(agentName)
  if (entry) pushTimelineBlock(entry, currentTime, { type: 'idle', label: `Compacted ${formatTokens(before)} → ${formatTokens(after)}`, color: COLORS.paused, endTime: currentTime + 1 }, ctx)
  appendConversation(state.conversations, agentName, { type: 'assistant', content: `⟲ CONTEXT COMPACTED (${formatTokens(before)} → ${formatTokens(after)})\n\nRelic:\n${relic}`, timestamp: currentTime })
}
