import type { SimulationState } from './types'
import { TOOL_MIN_DISPLAY_S, TOOL_MAX_RUNNING_S, DISCOVERY_HOLD_S, BUBBLE_VISIBLE_S, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'

/** Snap visual properties to their analytically correct values at a given time (used during seek) */
export function snapVisualState(state: SimulationState, targetTime: number): SimulationState {

  const newAgents = new Map(state.agents)
  for (const [id, agent] of newAgents) {
    if (agent.state === 'complete' && !agent.isMain) {
      // Remove completed sub-agents entirely during seek
      newAgents.delete(id)
      continue
    }
    const snapped = { ...agent }
    if (agent.state !== 'complete') {
      snapped.opacity = 1
      snapped.scale = 1
      snapped.timeAlive = targetTime - agent.spawnTime
    } else {
      // Main agent that completed
      snapped.opacity = 0.5
      snapped.scale = 1
    }
    snapped.messageBubbles = agent.messageBubbles.filter(b => targetTime - b.time <= BUBBLE_VISIBLE_S)
    newAgents.set(id, snapped)
  }

  const newToolCalls = new Map(state.toolCalls)
  for (const [id, tc] of newToolCalls) {
    const snapped = { ...tc }
    if (tc.state === 'running') {
      snapped.opacity = (targetTime - tc.startTime) > TOOL_MAX_RUNNING_S ? 0 : 1
    } else {
      const timeSinceComplete = targetTime - (tc.completeTime ?? 0)
      snapped.opacity = timeSinceComplete < TOOL_MIN_DISPLAY_S ? 1 : 0
    }
    newToolCalls.set(id, snapped)
  }

  // Snap service nodes
  const newServiceNodes = new Map(state.serviceNodes)
  for (const [id, svc] of newServiceNodes) {
    newServiceNodes.set(id, { ...svc, opacity: 1, scale: 1 })
  }

  // Filter edges: only keep edges where both endpoints are visible
  const newEdges = state.edges
    .map(e => {
      const fromAgent = newAgents.get(e.from)
      const toAgent = newAgents.get(e.to)
      const toTool = newToolCalls.get(e.to)
      const toService = newServiceNodes.get(e.to)
      const fromVisible = fromAgent && fromAgent.opacity > MIN_VISIBLE_OPACITY
      const toVisible = (toAgent && toAgent.opacity > MIN_VISIBLE_OPACITY) || (toTool && toTool.opacity > MIN_VISIBLE_OPACITY) || (toService && toService.opacity > MIN_VISIBLE_OPACITY)
      return { ...e, opacity: (fromVisible && toVisible) ? 1 : 0 }
    })
    .filter(e => e.opacity > 0)

  const newDiscoveries = state.discoveries.map(d => {
    const age = targetTime - d.timestamp
    return { ...d, x: d.targetX, y: d.targetY, opacity: age < DISCOVERY_HOLD_S ? 0.9 : 0 }
  }).filter(d => d.opacity > 0)

  return {
    ...state,
    agents: newAgents, toolCalls: newToolCalls, serviceNodes: newServiceNodes,
    edges: newEdges, particles: [], discoveries: newDiscoveries,
  }
}
