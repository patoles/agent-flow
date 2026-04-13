import type {
  Agent,
  ToolCallNode,
  Particle,
  Edge,
  Discovery,
  FileAttention,
  TimelineEntry,
  SimulationEvent,
} from '@/lib/agent-types'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'

export interface SimulationState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: Particle[]
  edges: Edge[]
  discoveries: Discovery[]
  fileAttention: Map<string, FileAttention>
  timelineEntries: Map<string, TimelineEntry>
  conversations: Map<string, ConversationMessage[]>
  currentTime: number
  isPlaying: boolean
  speed: number
  eventIndex: number
  eventLog: SimulationEvent[]
  /** Highest currentTime ever reached (for scrubber range in live mode) */
  maxTimeReached: number
}

/** Create an empty simulation state, optionally preserving specific fields */
export function createEmptyState(overrides?: Partial<SimulationState>): SimulationState {
  return {
    agents: new Map(),
    toolCalls: new Map(),
    particles: [],
    edges: [],
    discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map(),
    conversations: new Map(),
    currentTime: 0,
    isPlaying: false,
    speed: 1,
    eventIndex: 0,
    eventLog: [],
    maxTimeReached: 0,
    ...overrides,
  }
}

let _msgIdCounter = 0
export function nextMsgId(): string { return `msg-${_msgIdCounter++}` }

export interface ConversationMessage {
  id: string
  type: 'tool_call' | 'tool_result' | 'assistant' | 'user' | 'thinking'
  content: string
  timestamp: number
  toolName?: string
  inputData?: Record<string, unknown>
}

/** Max canvas message bubbles kept per agent (oldest are dropped) */
export const MAX_BUBBLES = 20

/** Max conversation messages kept per agent (oldest are dropped) */
export const MAX_CONVERSATION_MESSAGES = 200

/** Max events kept in the event log for seeking (oldest are dropped) */
export const MAX_EVENT_LOG = 5000

/** Append a message to a conversation, creating the array if needed.
 *  Auto-assigns a unique id if not provided.
 *  Caps history at MAX_CONVERSATION_MESSAGES per agent. */
export function appendConversation(
  conversations: Map<string, ConversationMessage[]>,
  agentName: string,
  message: Omit<ConversationMessage, 'id'> & { id?: string },
): void {
  const msg: ConversationMessage = { id: message.id ?? nextMsgId(), ...message }
  const msgs = conversations.get(agentName) || []
  const updated = [...msgs, msg]
  conversations.set(agentName, updated.length > MAX_CONVERSATION_MESSAGES ? updated.slice(-MAX_CONVERSATION_MESSAGES) : updated)
}

/** Build a deterministic edge ID from two node names */
export function edgeId(from: string, to: string): string {
  return `edge-${from}-${to}`
}

// ── Safe payload extraction helpers ──────────────────────────────────
export function asString(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback }
export function asNumber(v: unknown, fallback = 0): number { return typeof v === 'number' ? v : fallback }
export function asBoolean(v: unknown, fallback = false): boolean { return typeof v === 'boolean' ? v : fallback }

// ── Truncation length constants ──────────────────────────────────────
export const LABEL_LEN_SHORT = 25
export const LABEL_LEN_PARTICLE = 30
export const LABEL_LEN_TIMELINE = 40
export const LABEL_LEN_NAME = 40
export const LABEL_LEN_TASK = 120
export const LABEL_LEN_BUBBLE = 200

export interface ForceNode extends SimulationNodeDatum {
  id: string
}

export interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string
}

export interface UseAgentSimulationOptions {
  /** If true, use MOCK_SCENARIO for demo playback. Default: true */
  useMockData?: boolean
  /** External events to process (from VS Code bridge). Consumed each frame. */
  externalEvents?: readonly SimulationEvent[]
  /** Called after external events are consumed */
  onExternalEventsConsumed?: () => void
  /** If set, only process events matching this session ID */
  sessionFilter?: string | null
  /** Ref updated synchronously when session changes (avoids stale closure in rAF) */
  sessionFilterRef?: React.RefObject<string | null>
  /** If true, CLAUDE_CODE_DISABLE_1M_CONTEXT is set — cap context window to 200k */
  disable1MContext?: boolean
}
