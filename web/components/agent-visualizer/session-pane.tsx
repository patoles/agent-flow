'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { useSelectionState } from '@/hooks/use-selection-state'
import { useAudioEffects } from '@/hooks/use-audio-effects'
import { AgentCanvas } from './canvas'
import { AgentDetailCard } from './agent-detail-card'
import { stopPropagationHandlers } from './shared-ui'
import { COLORS } from '@/lib/colors'
import { TIMING } from '@/lib/agent-types'
import { deriveProjectWorktree } from '@/lib/session-grouping'
import type { SimulationEvent } from '@/lib/agent-types'
import type { Agent, ToolCallNode } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/bridge-types'

/** Stable empty collections so non-focused panes feed the audio hook nothing
 *  (no reference churn → no spurious transition detection). */
const EMPTY_AGENTS: Map<string, Agent> = new Map()
const EMPTY_TOOLS: Map<string, ToolCallNode> = new Map()

/** The slice of the VS Code bridge a pane needs to drive its own simulation. */
export interface PaneBridge {
  disable1MContext: boolean
  isVSCode: boolean
  openSessionFeed: (sessionId: string) => SimulationEvent[]
  consumeSessionFeed: (sessionId: string) => void
  closeSessionFeed: (sessionId: string) => void
  bridgeOpenFile: (filePath: string, line?: number) => void
}

interface SessionPaneProps {
  sessionId: string
  session: SessionInfo | undefined
  bridge: PaneBridge
  /** Only the focused pane emits audio, so N panes never overlap sounds. */
  focused: boolean
  onFocus: (sessionId: string) => void
}

/**
 * A self-contained visualization of ONE session: its own simulation instance,
 * its own canvas, its own selection state. Multiple panes render side by side in
 * the split view, each fed live events for its fixed `sessionId` (never the
 * globally-selected one). This is the building block that lets several concurrent
 * AO sessions be watched at once instead of one-conversation-per-page.
 */
export function SessionPane({ sessionId, session, bridge, focused, onFocus }: SessionPaneProps) {
  // Stable per-session event feed (seeded with backlog, appended in place).
  const [feed] = useState(() => bridge.openSessionFeed(sessionId))
  useEffect(() => () => bridge.closeSessionFeed(sessionId), [sessionId, bridge])

  const {
    frameRef, agents, toolCalls, discoveries,
    play, updateAgentPosition,
  } = useAgentSimulation({
    useMockData: false,
    externalEvents: feed,
    onExternalEventsConsumed: () => bridge.consumeSessionFeed(sessionId),
    // Defensive: the feed only ever holds this session's events, but the filter
    // guarantees a stray event can never bleed into the wrong pane.
    sessionFilter: sessionId,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })

  // Audio only for the focused pane; others feed the hook empty maps → silent.
  useAudioEffects(focused ? agents : EMPTY_AGENTS, focused ? toolCalls : EMPTY_TOOLS, false)

  // Auto-play this pane's simulation on mount.
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  const { project, worktree } = useMemo(
    () => deriveProjectWorktree(session?.cwd),
    [session?.cwd],
  )
  const label = session?.label || sessionId.slice(0, 8)
  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      onMouseDownCapture={() => { if (!focused) onFocus(sessionId) }}
      style={{
        border: `1px solid ${focused ? COLORS.holoBorder12 : COLORS.holoBorder06}`,
        boxShadow: focused ? `inset 0 0 0 1px ${COLORS.holoBorder12}` : undefined,
      }}
    >
      <AgentCanvas
        simulationRef={frameRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={false}
        showHexGrid={true}
        onAgentClick={selection.handleAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={updateAgentPosition}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
      />

      {/* Pane header: project › worktree › label + live agent count */}
      <div
        className="absolute top-1.5 left-1.5 flex items-center gap-1.5 font-mono text-[10px] pointer-events-none max-w-[calc(100%-12px)]"
        style={{ color: COLORS.textMuted }}
      >
        <span style={{ color: COLORS.holoBright, fontWeight: 600 }} className="truncate">{project}</span>
        {worktree && <><span style={{ opacity: 0.5 }}>›</span><span className="truncate">{worktree}</span></>}
        <span style={{ opacity: 0.5 }}>›</span>
        <span className="truncate" style={{ opacity: 0.85 }}>{label}</span>
        <span style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>· {agents.size}</span>
        {session?.status === 'completed' && (
          <span style={{ color: COLORS.idle, whiteSpace: 'nowrap' }}>· done</span>
        )}
      </div>

      {/* Agent detail card (absolute → positioned within this pane) */}
      {selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard agent={selectedAgent} onClose={selection.clearAgent} />
        </div>
      )}
    </div>
  )
}
