import {
  Agent,
  ToolCallNode,
  ServiceNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
  type TimelineBlock,
} from '@/lib/agent-types'
import type { SimulationState, ConversationMessage } from './types'
import { handleAgentSpawn, handleAgentComplete, handleAgentIdle, handlePermissionRequested, handleModelDetected } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage, handleContextUpdate } from './handle-message-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'

export interface ProcessEventContext {
  syncForceSimulation: (agents: Map<string, Agent>, edges: Edge[]) => void
  findToolSlot: (agent: Agent, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>, currentTime: number) => { x: number; y: number }
  getContextWindowSize: (modelId?: string) => number
  blockIdCounter: { current: number }
  skipForceSync: boolean
}

/** Mutable collections that handlers mutate in place during a single processEvent call. */
export interface MutableEventState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  serviceNodes: Map<string, ServiceNode>
  particles: SimulationState['particles']
  edges: Edge[]
  discoveries: SimulationState['discoveries']
  fileAttention: SimulationState['fileAttention']
  timelineEntries: SimulationState['timelineEntries']
  conversations: Map<string, ConversationMessage[]>
}

/** Close the last open block on a timeline entry and push a new one. */
export function pushTimelineBlock(
  entry: TimelineEntry,
  currentTime: number,
  block: Pick<TimelineBlock, 'type' | 'label' | 'color'> & { endTime?: number },
  ctx: ProcessEventContext,
): void {
  const lastBlock = entry.blocks[entry.blocks.length - 1]
  if (lastBlock && !lastBlock.endTime) lastBlock.endTime = currentTime
  entry.blocks.push({
    id: `block-${ctx.blockIdCounter.current++}`,
    type: block.type,
    startTime: currentTime,
    endTime: block.endTime,
    label: block.label,
    color: block.color,
  })
}

/** Shallow-compare two Maps by reference equality of values */
function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

export function processEvent(event: SimulationEvent, prev: SimulationState, ctx: ProcessEventContext): SimulationState {
      const state: MutableEventState = {
        agents: new Map(prev.agents),
        toolCalls: new Map(prev.toolCalls),
        serviceNodes: new Map(prev.serviceNodes),
        particles: [...prev.particles],
        edges: [...prev.edges],
        discoveries: [...prev.discoveries],
        fileAttention: new Map(prev.fileAttention),
        timelineEntries: new Map(prev.timelineEntries),
        conversations: new Map(prev.conversations),
      }

      switch (event.type) {
        case 'agent_spawn':       handleAgentSpawn(event.payload, prev.currentTime, state, ctx); break
        case 'agent_complete':    handleAgentComplete(event.payload, prev.currentTime, state, ctx); break
        case 'agent_idle':        handleAgentIdle(event.payload, state); break
        case 'model_detected':    handleModelDetected(event.payload, state, ctx); break
        case 'tool_call_start':   handleToolCallStart(event.payload, prev.currentTime, state, ctx); break
        case 'tool_call_end':     handleToolCallEnd(event.payload, prev.currentTime, state, ctx); break
        case 'message':           handleMessage(event.payload, prev.currentTime, state); break
        case 'context_update':    handleContextUpdate(event.payload, state); break
        case 'subagent_dispatch': handleSubagentDispatch(event.payload, prev.currentTime, state); break
        case 'subagent_return':   handleSubagentReturn(event.payload, prev.currentTime, state); break
        case 'permission_requested': handlePermissionRequested(event.payload, prev.currentTime, state, ctx); break
      }

      // Stabilize references for unchanged collections to prevent
      // downstream React useMemo/re-render cascades (O(n log n) sorts etc.)
      return {
        ...prev,
        agents: state.agents, toolCalls: state.toolCalls, serviceNodes: state.serviceNodes,
        particles: state.particles, edges: state.edges,
        discoveries: state.discoveries,
        fileAttention: mapsEqual(prev.fileAttention, state.fileAttention) ? prev.fileAttention : state.fileAttention,
        timelineEntries: mapsEqual(prev.timelineEntries, state.timelineEntries) ? prev.timelineEntries : state.timelineEntries,
        conversations: mapsEqual(prev.conversations, state.conversations) ? prev.conversations : state.conversations,
      }
}
