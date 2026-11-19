import { COLORS } from '@/lib/colors'
import { TOOL_DEDUP_WINDOW_S } from '@/lib/canvas-constants'
import type { ToolCallNode } from '@/lib/agent-types'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, asString, asBoolean, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || args?.split(' ')[0] || ''
}

/** Whether both the event and the node carry a toolUseId, so they can be matched exactly.
 *  Older recordings and sources without ids fall back to matching by tool name. */
function bothHaveIds(tc: ToolCallNode, toolUseId: string): boolean {
  return Boolean(toolUseId && tc.toolUseId)
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const toolUseId = asString(payload.toolUseId)
  const args = asString(payload.args)
  const inputData = (payload.inputData && typeof payload.inputData === 'object' && !Array.isArray(payload.inputData))
    ? payload.inputData as Record<string, unknown> : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    // Dedup: the Hook Server and the Session Watcher both report each call with the
    // same toolUseId. Without ids, skip a running call for the same agent+tool
    // created within the last 3 seconds instead.
    let isDuplicate = false
    for (const tc of state.toolCalls.values()) {
      if (tc.agentId !== agentName) continue
      if (bothHaveIds(tc, toolUseId)
        ? tc.toolUseId === toolUseId
        : tc.toolName === toolName && tc.state === 'running' && (currentTime - tc.startTime) < TOOL_DEDUP_WINDOW_S) {
        isDuplicate = true
        break
      }
    }
    if (isDuplicate) return

    state.agents.set(agentName, {
      ...agent,
      state: 'tool_calling',
      currentTool: toolName,
      toolCalls: agent.toolCalls + 1
    })

    const toolId = toolUseId ? `tool-${agentName}-${toolUseId}` : `tool-${agentName}-${toolName}-${currentTime}`

    const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, currentTime)

    state.toolCalls.set(toolId, {
      id: toolId, agentId: agentName, toolName,
      ...(toolUseId ? { toolUseId } : {}),
      state: 'running',
      args,
      inputData,
      x: pos.x,
      y: pos.y,
      startTime: currentTime,
      opacity: 0,
    })

    state.edges.push({ id: `edge-${toolId}`, from: agentName, to: toolId, type: 'tool', opacity: 0 })

    state.particles.push({
      id: `p-tc-${currentTime}-${toolId}`,
      edgeId: `edge-${toolId}`, progress: 0,
      type: 'tool_call', color: COLORS.tool,
      size: 4, trailLength: 0.15,
      label: `${toolName} ${args}`.slice(0, LABEL_LEN_PARTICLE),
    })

    // Timeline block
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'tool_call', label: `${toolName}: ${args}`.slice(0, LABEL_LEN_TIMELINE), color: COLORS.tool }, ctx)
    }

    // Track file attention
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const filePath = extractFilePath(inputData, args)
      if (filePath) {
        const prev = state.fileAttention.get(filePath)
        const updated = prev
          ? { ...prev, agents: [...prev.agents] }
          : { path: filePath, reads: 0, edits: 0, totalTokens: 0, lastAccessed: currentTime, agents: [] as string[] }
        if (toolName === 'Read') updated.reads++
        else updated.edits++
        updated.lastAccessed = currentTime
        if (!updated.agents.includes(agentName)) updated.agents.push(agentName)
        state.fileAttention.set(filePath, updated)
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_call', content: `> ${toolName} ${args}`, timestamp: currentTime,
      toolName, inputData,
    })
  }
}

export function handleToolCallEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const toolUseId = asString(payload.toolUseId)
  const result = asString(payload.result, 'Done')
  const tokenCost = typeof payload.tokenCost === 'number' ? payload.tokenCost : undefined
  const isError = asBoolean(payload.isError)
  const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
  const agent = state.agents.get(agentName)
  const isSameCall = (tc: ToolCallNode) => tc.agentId === agentName
    && (bothHaveIds(tc, toolUseId) ? tc.toolUseId === toolUseId : tc.toolName === toolName)

  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      state: isError ? 'error' : 'thinking',
      currentTool: undefined,
      tokensUsed: agent.tokensUsed + (tokenCost ?? 0),
    })

    const toolState: 'error' | 'complete' = isError ? 'error' : 'complete'
    for (const [id, tc] of state.toolCalls) {
      if (isSameCall(tc) && tc.state === 'running') {
        state.toolCalls.set(id, { ...tc, state: toolState, completeTime: currentTime, result, tokenCost, errorMessage: isError ? (errorMessage || result) : undefined })

        const edgeId = `edge-${id}`
        // Snap any still-traveling outgoing particle to the end
        const outIdx = state.particles.findIndex(p => p.edgeId === edgeId && p.type === 'tool_call')
        if (outIdx !== -1) state.particles[outIdx] = { ...state.particles[outIdx], progress: 0.95 }

        state.particles.push({
          id: `p-tr-${currentTime}-${id}`,
          edgeId, progress: 1,
          type: 'tool_return', color: COLORS.return,
          size: 4, trailLength: 0.15,
          label: result.slice(0, LABEL_LEN_PARTICLE),
        })
        break
      }
    }

    // Timeline block end
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      if (isError) {
        const lastBlock = entry.blocks[entry.blocks.length - 1]
        if (lastBlock && !lastBlock.endTime) {
          lastBlock.color = COLORS.error
          lastBlock.label = `${toolName}: FAILED`
        }
      }
      pushTimelineBlock(entry, currentTime, { type: 'thinking', label: 'Thinking...', color: COLORS.thinking }, ctx)
    }

    // File attention token cost
    if (tokenCost) {
      const matchedTc = Array.from(state.toolCalls.values()).find(isSameCall)
      const filePath = extractFilePath(matchedTc?.inputData, matchedTc?.args)
      if (filePath) {
        const existing = state.fileAttention.get(filePath)
        if (existing) {
          state.fileAttention.set(filePath, { ...existing, totalTokens: existing.totalTokens + tokenCost })
        }
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_result',
      content: `< ${result}${tokenCost ? ` (${tokenCost} tokens)` : ''}`,
      timestamp: currentTime,
      toolName,
    })
  }
}
