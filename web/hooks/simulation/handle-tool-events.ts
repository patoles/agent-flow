import { COLORS } from '@/lib/colors'
import { type ServiceNode } from '@/lib/agent-types'
import { TOOL_DEDUP_WINDOW_S, SERVICE_NODE } from '@/lib/canvas-constants'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, edgeId, asString, asBoolean, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'

/** Well-known MCP server display names */
const MCP_DISPLAY_NAMES: Record<string, string> = {
  'azure-devops': 'Azure DevOps',
  'azure': 'Azure',
  'github': 'GitHub',
  'google-workspace': 'Google Workspace',
  'context7': 'Context7',
  'claude_ai_Gmail': 'Gmail',
  'claude_ai_Slack': 'Slack',
  'mercadopago': 'Mercado Pago',
}

/** Parse MCP tool name to extract server. Returns null for non-MCP tools. */
function parseMcpServer(toolName: string): { server: string; displayName: string } | null {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.split('__')
  if (parts.length < 3) return null
  const server = parts[1]
  const displayName = MCP_DISPLAY_NAMES[server]
    || server.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return { server, displayName }
}

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || args?.split(' ')[0] || ''
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const args = asString(payload.args)
  const inputData = (payload.inputData && typeof payload.inputData === 'object' && !Array.isArray(payload.inputData))
    ? payload.inputData as Record<string, unknown> : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    // Dedup: skip if there's already a running tool call for the same agent+tool
    // created within the last 3 seconds (race between Hook Server and Session Watcher)
    let isDuplicate = false
    for (const tc of state.toolCalls.values()) {
      if (tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running' && (currentTime - tc.startTime) < TOOL_DEDUP_WINDOW_S) {
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

    const toolId = `tool-${agentName}-${toolName}-${currentTime}`

    const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, currentTime)

    state.toolCalls.set(toolId, {
      id: toolId, agentId: agentName, toolName,
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

    // MCP service node: create/update when tool is an MCP call
    const mcpInfo = parseMcpServer(toolName)
    if (mcpInfo) {
      const serviceId = `service-${mcpInfo.server}`
      const existing = state.serviceNodes.get(serviceId)
      if (existing) {
        const connectedAgents = existing.connectedAgents.includes(agentName)
          ? existing.connectedAgents
          : [...existing.connectedAgents, agentName]
        state.serviceNodes.set(serviceId, {
          ...existing,
          totalCalls: existing.totalCalls + 1,
          activeCalls: existing.activeCalls + 1,
          lastActiveTime: currentTime,
          connectedAgents,
        })
      } else {
        // Spawn service node offset from the agent
        const angle = Math.PI / 2 + Math.random() * Math.PI  // bottom-ish hemisphere
        const svc: ServiceNode = {
          id: serviceId,
          name: mcpInfo.server,
          displayName: mcpInfo.displayName,
          x: agent.x + Math.cos(angle) * SERVICE_NODE.spawnDistance,
          y: agent.y + Math.sin(angle) * SERVICE_NODE.spawnDistance,
          vx: 0, vy: 0,
          totalCalls: 1,
          activeCalls: 1,
          lastActiveTime: currentTime,
          opacity: 0,
          scale: 0.3,
          connectedAgents: [agentName],
        }
        state.serviceNodes.set(serviceId, svc)
      }

      // Ensure edge from agent → service exists
      const svcEdgeId = edgeId(agentName, serviceId)
      if (!state.edges.some(e => e.id === svcEdgeId)) {
        state.edges.push({ id: svcEdgeId, from: agentName, to: serviceId, type: 'service', opacity: 0 })
      }

      // Particle along agent → service edge
      state.particles.push({
        id: `p-svc-${currentTime}-${toolId}`,
        edgeId: edgeId(agentName, serviceId), progress: 0,
        type: 'tool_call', color: COLORS.service,
        size: 5, trailLength: 0.2,
        label: mcpInfo.displayName,
      })

      // Sync force after adding service node
      if (!ctx.skipForceSync) {
        setTimeout(() => ctx.syncForceSimulation(state.agents, state.edges), 0)
      }
    }

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
  const result = asString(payload.result, 'Done')
  const tokenCost = typeof payload.tokenCost === 'number' ? payload.tokenCost : undefined
  const isError = asBoolean(payload.isError)
  const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      state: isError ? 'error' : 'thinking',
      currentTool: undefined,
      tokensUsed: agent.tokensUsed + (tokenCost ?? 0),
    })

    const toolState: 'error' | 'complete' = isError ? 'error' : 'complete'
    for (const [id, tc] of state.toolCalls) {
      if (tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running') {
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

    // MCP service node: decrement active calls
    const mcpInfoEnd = parseMcpServer(toolName)
    if (mcpInfoEnd) {
      const serviceId = `service-${mcpInfoEnd.server}`
      const svc = state.serviceNodes.get(serviceId)
      if (svc) {
        state.serviceNodes.set(serviceId, {
          ...svc,
          activeCalls: Math.max(0, svc.activeCalls - 1),
          lastActiveTime: currentTime,
        })
      }

      // Return particle along service → agent edge
      const svcEdgeId = edgeId(agentName, serviceId)
      state.particles.push({
        id: `p-svcr-${currentTime}-${toolName}`,
        edgeId: svcEdgeId, progress: 1,
        type: 'tool_return', color: COLORS.service,
        size: 5, trailLength: 0.2,
        label: result.slice(0, LABEL_LEN_PARTICLE),
      })
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
      const matchedTc = Array.from(state.toolCalls.values()).find(tc => tc.agentId === agentName && tc.toolName === toolName)
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
