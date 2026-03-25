'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
} from '@/lib/agent-types'
import { MOCK_SCENARIO } from '@/lib/mock-scenario'
import { TOOL_CARD_W, TOOL_CARD_H, FORCE, TOOL_SLOT, BUBBLE_VISIBLE_S, MODEL_CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, ANIM_SPEED } from '@/lib/canvas-constants'
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation } from 'd3-force'

import type { SimulationState, ForceNode, ForceLink, UseAgentSimulationOptions } from './simulation/types'
import { createEmptyState, resetMsgIdCounter, MAX_EVENT_LOG } from './simulation/types'
import { processEvent, type ProcessEventContext } from './simulation/process-event'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'

export function useAgentSimulation(options: UseAgentSimulationOptions = {}) {
  const { useMockData = true, externalEvents, onExternalEventsConsumed, sessionFilter, sessionFilterRef: externalFilterRef } = options
  // Ref so the animation frame always reads the current sessionFilter,
  // not a stale closure value from when animate was last recreated.
  const internalFilterRef = useRef(sessionFilter)
  internalFilterRef.current = sessionFilter
  // Use the external ref if provided (updated synchronously in event handlers),
  // otherwise fall back to the internal ref (updated during render).
  const sessionFilterRef = externalFilterRef ?? internalFilterRef
  const [state, setState] = useState<SimulationState>(createEmptyState)
  const animationRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const forceSimRef = useRef<Simulation<ForceNode, ForceLink> | null>(null)
  const blockIdCounter = useRef(0)
  /** When true, processEvent skips force sim sync (during seek replay) */
  const skipForceSyncRef = useRef(false)
  // Stable ref to animate — lets the useEffect/rAF loop always call the latest
  // version without depending on animate's identity (which changes with props).
  const animateRef = useRef<(timestamp: number) => void>(() => {})

  // Initialize d3-force simulation
  useEffect(() => {
    const sim = forceSimulation<ForceNode, ForceLink>([])
      .force('charge', forceManyBody().strength(FORCE.chargeStrength))
      .force('center', forceCenter(0, 0).strength(FORCE.centerStrength))
      .force('collide', forceCollide(FORCE.collideRadius))
      .force('link', forceLink<ForceNode, ForceLink>([]).id(d => d.id).distance(FORCE.linkDistance).strength(FORCE.linkStrength))
      .alphaDecay(FORCE.alphaDecay)
      .velocityDecay(FORCE.velocityDecay)
      .on('tick', () => {
        setState(prev => {
          const newAgents = new Map(prev.agents)
          let changed = false
          for (const node of sim.nodes()) {
            const agent = newAgents.get(node.id)
            if (agent && !agent.pinned && node.x !== undefined && node.y !== undefined) {
              if (Math.abs(agent.x - node.x) > 0.1 || Math.abs(agent.y - node.y) > 0.1) {
                newAgents.set(node.id, { ...agent, x: node.x, y: node.y })
                changed = true
              }
            }
          }
          return changed ? { ...prev, agents: newAgents } : prev
        })
      })

    sim.stop()
    forceSimRef.current = sim

    return () => {
      sim.stop()
      forceSimRef.current = null
    }
  }, [])

  const syncForceSimulation = useCallback((agents: Map<string, Agent>, edges: Edge[]) => {
    const sim = forceSimRef.current
    if (!sim) return

    const nodes: ForceNode[] = Array.from(agents.values()).map(a => ({
      id: a.id,
      x: a.x, y: a.y,
      vx: a.vx, vy: a.vy,
      fx: a.pinned ? a.x : undefined,
      fy: a.pinned ? a.y : undefined,
    }))

    const links: ForceLink[] = edges
      .filter(e => e.type === 'parent-child')
      .map(e => ({ id: e.id, source: e.from, target: e.to }))

    sim.nodes(nodes)
    const linkForce = sim.force('link') as ReturnType<typeof forceLink> | undefined
    if (linkForce) linkForce.links(links)
    sim.alpha(0.3).restart()
    for (let i = 0; i < 15; i++) sim.tick()
    sim.stop()
  }, [])

  // Find a clear slot for a tool card, spawning outward from the agent (away from parent)
  const findToolSlot = useCallback((
    agent: Agent, agents: Map<string, Agent>,
    toolCalls: Map<string, ToolCallNode>, currentTime: number,
  ): { x: number; y: number } => {
    const visibleBubbles = agent.messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
    const bubbleRect = visibleBubbles.length > 0 ? {
      x1: agent.x + 30, y1: agent.y - 30,
      x2: agent.x + 300, y2: agent.y - 20 + visibleBubbles.length * 60 + 20,
    } : null

    const overlaps = (cx: number, cy: number) => {
      if (bubbleRect && cx + TOOL_CARD_W / 2 > bubbleRect.x1 && cx - TOOL_CARD_W / 2 < bubbleRect.x2
        && cy + TOOL_CARD_H / 2 > bubbleRect.y1 && cy - TOOL_CARD_H / 2 < bubbleRect.y2) return true
      for (const tc of toolCalls.values()) {
        if (Math.abs(cx - tc.x) < TOOL_CARD_W && Math.abs(cy - tc.y) < TOOL_CARD_H) return true
      }
      return false
    }

    // Compute outward direction: away from parent (or default upward for main agent)
    let outAngle = -Math.PI / 2 // default: upward
    if (agent.parentId) {
      const parent = agents.get(agent.parentId)
      if (parent) {
        outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
      }
    }

    // Arc centered on outward direction, sweeping ±90°
    for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
      const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
      const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
      for (let i = 0; i < steps; i++) {
        const sweep = (i / (steps - 1) - 0.5) * Math.PI // -90° to +90° around outAngle
        const angle = outAngle + sweep
        const cx = agent.x + Math.cos(angle) * dist
        const cy = agent.y + Math.sin(angle) * dist
        if (!overlaps(cx, cy)) return { x: cx, y: cy }
      }
    }
    return { x: agent.x + Math.cos(outAngle) * TOOL_SLOT.fallbackDistance, y: agent.y + Math.sin(outAngle) * TOOL_SLOT.fallbackDistance }
  }, [])

  const getContextWindowSize = useCallback((modelId?: string): number => {
    if (!modelId) return FALLBACK_CONTEXT_SIZE
    const id = modelId.toLowerCase()
    for (const [key, size] of Object.entries(MODEL_CONTEXT_SIZES)) {
      if (id.includes(key)) return size
    }
    return DEFAULT_CONTEXT_SIZE
  }, [])

  const processEventWithContext = useCallback((event: SimulationEvent, prev: SimulationState): SimulationState => {
    const ctx: ProcessEventContext = {
      syncForceSimulation,
      findToolSlot,
      getContextWindowSize,
      blockIdCounter,
      skipForceSync: skipForceSyncRef.current,
    }
    return processEvent(event, prev, ctx)
  }, [syncForceSimulation, findToolSlot, getContextWindowSize])

  const animate = useCallback((timestamp: number) => {
    if (!lastTimeRef.current) lastTimeRef.current = timestamp
    const deltaTime = Math.min((timestamp - lastTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
    lastTimeRef.current = timestamp

    // Snapshot and consume external events OUTSIDE setState so that
    // React StrictMode's double-invocation of the updater doesn't
    // see an empty array on the second call (the first call would
    // have cleared it via onExternalEventsConsumed).
    let externalSnapshot: SimulationEvent[] | null = null
    if (externalEvents && externalEvents.length > 0) {
      externalSnapshot = externalEvents.slice()
      onExternalEventsConsumed?.()
    }

    setState(prev => {
      if (!prev.isPlaying) return prev

      let newTime = prev.currentTime + deltaTime * prev.speed
      let maxT = Math.max(prev.maxTimeReached, newTime)
      let newEventIndex = prev.eventIndex

      // Process events — thread state through each event
      let currentState = prev
      const newEvents: SimulationEvent[] = []

      // Process events from the appropriate source as time advances
      if (useMockData) {
        // Mock mode: process from MOCK_SCENARIO
        while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
          const evt = MOCK_SCENARIO[newEventIndex]
          currentState = processEventWithContext(evt, currentState)
          newEvents.push(evt)
          newEventIndex++
        }
      } else {
        // Live mode: replay events from eventLog as time advances
        // (This handles post-seek catch-up: after seeking backward, events
        // between the seek target and the original time get re-processed
        // as currentTime advances past them)
        while (newEventIndex < currentState.eventLog.length && currentState.eventLog[newEventIndex].time <= newTime) {
          const evt = currentState.eventLog[newEventIndex]
          currentState = processEventWithContext(evt, currentState)
          newEventIndex++
        }
      }

      // Process NEW external events (from VS Code bridge / event hub)
      if (externalSnapshot) {
        for (const event of externalSnapshot) {
          // Filter by session if specified — use ref so we always read the
          // latest value even if the animate closure hasn't been recreated yet.
          // The ref is also updated synchronously via onSessionFilterChange callback
          // so it's current even before React re-renders.
          const activeFilter = sessionFilterRef.current
          if (activeFilter && event.sessionId && event.sessionId !== activeFilter) {
            continue
          }
          // Clamp event time to at least the current sim time so that
          // bubbles/effects created by this event appear fresh, not pre-aged
          const eventTime = Math.max(event.time || newTime, newTime)
          const timedEvent = { ...event, time: eventTime }
          // Advance currentTime so processEvent sees correct timestamps
          // (critical for session-switch replay where many events arrive at once)
          currentState = { ...currentState, currentTime: eventTime }
          currentState = processEventWithContext(timedEvent, currentState)
          newEvents.push(timedEvent)
        }
        // Sync simulation clock to latest event so active state renders correctly
        newTime = Math.max(newTime, currentState.currentTime)
        maxT = Math.max(maxT, newTime)
      }

      // Append new events to log and advance eventIndex past them
      if (newEvents.length > 0) {
        let newLog = currentState.eventLog.concat(newEvents)
        // Cap event log to prevent unbounded memory growth
        if (newLog.length > MAX_EVENT_LOG) {
          const drop = newLog.length - MAX_EVENT_LOG
          newLog = newLog.slice(drop)
          newEventIndex = newLog.length
        } else {
          newEventIndex = newLog.length
        }
        currentState = { ...currentState, eventLog: newLog }
      }

      // Update eventIndex on currentState before passing to computeNextFrame
      currentState = { ...currentState, eventIndex: newEventIndex }

      const result = computeNextFrame(prev, deltaTime, newTime, maxT, currentState, {
        useMockData,
        mockScenarioLength: MOCK_SCENARIO.length,
        mockScenarioEndTime: MOCK_SCENARIO.length > 0 ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time : 0,
      })

      if (forceSimRef.current) forceSimRef.current.tick()

      return result
    })

    animationRef.current = requestAnimationFrame(animateRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionFilter intentionally omitted; we read sessionFilterRef.current to avoid stale closures
  }, [processEventWithContext, useMockData, externalEvents, onExternalEventsConsumed])

  animateRef.current = animate

  useEffect(() => {
    const loop = (timestamp: number) => animateRef.current(timestamp)
    if (state.isPlaying) {
      lastTimeRef.current = 0
      animationRef.current = requestAnimationFrame(loop)
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
    }
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  }, [state.isPlaying])

  const play = useCallback(() => setState(prev => ({ ...prev, isPlaying: true })), [])
  const pause = useCallback(() => setState(prev => ({ ...prev, isPlaying: false })), [])

  const restart = useCallback((keepActive = false) => {
    blockIdCounter.current = 0
    resetMsgIdCounter()
    if (!keepActive) {
      setState(prev => createEmptyState({ isPlaying: true, speed: prev.speed }))
      return
    }
    // Keep active agents but clear completed state and visual history.
    // Trim the event log to only agent_spawn events for surviving agents
    // so seekToTime can reconstruct them during review mode.
    setState(prev => {
      const agents = new Map<string, Agent>()
      for (const [id, agent] of prev.agents) {
        if (agent.state !== 'complete') {
          agents.set(id, { ...agent, toolCalls: 0, messageBubbles: [], timeAlive: 0 })
        }
      }

      const edges = prev.edges.filter(e =>
        e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to)
      )

      const timelineEntries = new Map<string, TimelineEntry>()
      for (const [id, entry] of prev.timelineEntries) {
        if (agents.has(id)) {
          timelineEntries.set(id, { ...entry, blocks: [] })
        }
      }

      const conversations: SimulationState['conversations'] = new Map()
      for (const id of agents.keys()) conversations.set(id, [])

      const eventLog = prev.eventLog.filter(e =>
        e.type === 'agent_spawn' && agents.has(e.payload?.name as string)
      )

      return {
        ...createEmptyState({ isPlaying: true, speed: prev.speed }),
        agents, edges, timelineEntries, conversations,
        eventLog, eventIndex: eventLog.length,
      }
    })
    // Re-sync force simulation with surviving agents
    setTimeout(() => {
      const s = stateRef.current
      syncForceSimulation(s.agents, s.edges)
    }, 0)
  }, [syncForceSimulation])

  const setSpeed = useCallback((speed: number) => setState(prev => ({ ...prev, speed })), [])

  const updateAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    setState(prev => {
      const newAgents = new Map(prev.agents)
      const agent = newAgents.get(agentId)
      if (agent) newAgents.set(agentId, { ...agent, x, y, pinned: true })
      return { ...prev, agents: newAgents }
    })
    if (forceSimRef.current) {
      const node = forceSimRef.current.nodes().find(n => n.id === agentId)
      if (node) { node.fx = x; node.fy = y }
    }
  }, [])

  /** Seek to a specific time — replays events from scratch up to targetTime */
  const seekToTime = useCallback((targetTime: number) => {
    setState(prev => {
      // In mock mode, always use MOCK_SCENARIO (has all future events).
      // In live mode, use the eventLog (only has events received so far).
      const events = useMockData ? MOCK_SCENARIO : prev.eventLog

      // Reset to blank state (preserve maxTimeReached for scrubber range)
      let replayState = createEmptyState({
        speed: prev.speed,
        eventLog: prev.eventLog,
        maxTimeReached: prev.maxTimeReached,
      })

      // Replay all events up to targetTime (suppress force sim during replay)
      skipForceSyncRef.current = true
      blockIdCounter.current = 0
      let newEventIndex = 0
      for (const event of events) {
        if (event.time > targetTime) break
        replayState.currentTime = event.time
        replayState = { ...processEventWithContext(event, replayState), currentTime: event.time }
        newEventIndex++
      }
      skipForceSyncRef.current = false

      // Snap visual state analytically
      replayState = snapVisualState(replayState, targetTime)
      replayState.currentTime = targetTime
      replayState.eventIndex = newEventIndex

      // Single force simulation sync with the final state
      setTimeout(() => syncForceSimulation(replayState.agents, replayState.edges), 0)

      return replayState
    })
  }, [processEventWithContext, useMockData, syncForceSimulation])

  // ─── Session state save/restore ────────────────────────────────────────────
  const stateRef = useRef(state)
  stateRef.current = state

  const saveSnapshot = useCallback((): { simState: SimulationState; blockId: number } => ({
    simState: stateRef.current,
    blockId: blockIdCounter.current,
  }), [])

  const restoreSnapshot = useCallback((snapshot: { simState: SimulationState; blockId: number }) => {
    blockIdCounter.current = snapshot.blockId
    setState({ ...snapshot.simState, isPlaying: true })
    setTimeout(() => syncForceSimulation(snapshot.simState.agents, snapshot.simState.edges), 0)
  }, [syncForceSimulation])

  return {
    agents: state.agents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: state.fileAttention,
    timelineEntries: state.timelineEntries,
    currentTime: state.currentTime, isPlaying: state.isPlaying, speed: state.speed,
    maxTimeReached: state.maxTimeReached,
    conversations: state.conversations,
    play, pause, restart, setSpeed, seekToTime,
    updateAgentPosition,
    saveSnapshot, restoreSnapshot,
  }
}
