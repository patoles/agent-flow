/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
}

/** A same-file collision between agents (same or different sessions), as reported by the backend */
export interface FileCollision {
  file: string
  parties: Array<{ sessionId: string; agent: string; action: 'read' | 'write'; wall: number }>
  sessions: string[]
  /** browser receipt time, for expiry */
  seenAt: number
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
