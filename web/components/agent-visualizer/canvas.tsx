'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { Agent, ToolCallNode, Particle, Edge, Discovery, DepthParticle } from '@/lib/agent-types'
import { getStateColor } from '@/lib/colors'
import { ANIM_SPEED } from '@/lib/canvas-constants'
import { BloomRenderer } from './bloom-renderer'
import { createDepthParticles, updateDepthParticles, drawBackground } from './background-layer'
import {
  type VisualEffect,
  drawTetherLine,
  drawEffects,
  drawAgents,
  drawMessageBubblesWorld,
  drawEdges, getActiveEdgeIds,
  drawParticles, buildEdgeMap,
  drawToolCalls,
  drawDiscoveries, drawDiscoveryConnections,
  drawCostLabels, drawCostSummaryPanel,
  detectStateChanges as detectStateChangesPure,
} from './canvas/index'
import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { useCanvasInteraction } from '@/hooks/use-canvas-interaction'

interface CanvasProps {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: Particle[]
  edges: Edge[]
  discoveries: Discovery[]
  selectedAgentId: string | null
  hoveredAgentId: string | null
  showStats: boolean
  showHexGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  selectedToolCallId?: string | null
  onDiscoveryClick?: (discoveryId: string | null) => void
  selectedDiscoveryId?: string | null
  currentTime?: number
  showCostOverlay?: boolean
}

export function AgentCanvas({
  agents, toolCalls, particles, edges, discoveries,
  selectedAgentId, hoveredAgentId, showStats, showHexGrid, zoomToFitTrigger, pauseAutoFit,
  onAgentClick, onAgentHover, onAgentDrag, onContextMenu, onToolCallClick, selectedToolCallId, onDiscoveryClick, selectedDiscoveryId, currentTime: simTime, showCostOverlay,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const simTimeRef = useRef(0)
  const bloomRef = useRef<BloomRenderer | null>(null)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const lastFrameTimeRef = useRef(0)
  const dprRef = useRef(1)

  // Effects system
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())

  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)

  // Caches for per-frame lookups — avoid rebuilding Set/Map every ~16ms
  const edgeLookupCacheRef = useRef<{
    particles: Particle[]
    edges: Edge[]
    activeEdgeIds: Set<string>
    edgeMap: Map<string, Edge>
  }>({ particles: [], edges: [], activeEdgeIds: new Set(), edgeMap: new Map() })

  // ─── Stable refs for animation loop & event handlers ────────────────────
  const makeDrawProps = (prev?: { isDragging: boolean }) => ({
    agents, toolCalls, particles, edges, discoveries,
    selectedAgentId, hoveredAgentId, showStats, showHexGrid,
    showCostOverlay, selectedToolCallId, selectedDiscoveryId,
    simTime, pauseAutoFit, dimensions,
    onAgentDrag, onAgentClick, onAgentHover, onContextMenu,
    onToolCallClick, onDiscoveryClick,
    isDragging: prev?.isDragging ?? false,
  })
  const drawPropsRef = useRef(makeDrawProps())
  drawPropsRef.current = makeDrawProps(drawPropsRef.current)

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, userHasNavigatedRef, panVelocityRef,
    screenToCanvas, doZoomToFit, updateCamera,
  } = useCanvasCamera({
    mainCanvasRef, drawPropsRef, simTimeRef, dimensions,
    agentCount: agents.size, zoomToFitTrigger, selectedAgentId,
  })

  // ─── Interaction ────────────────────────────────────────────────────────
  const {
    isDragging, handlers, updateDragLerp,
  } = useCanvasInteraction({
    drawPropsRef, transformRef, userHasNavigatedRef, panVelocityRef,
    simTimeRef, screenToCanvas, doZoomToFit, mainCanvasRef,
  })

  // Keep drawPropsRef in sync with interaction state
  drawPropsRef.current.isDragging = isDragging

  // ─── Setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    bloomRef.current = new BloomRenderer(0.5)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { bloomRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- particles created once, resized by draw loop
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        const h = entry.contentRect.height
        setDimensions({ width: w, height: h })
        bloomRef.current?.resize(w * dpr, h * dpr)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Detect state changes → spawn effects ──────────────────────────────

  const detectStateChanges = useCallback(() => {
    const { agents, toolCalls } = drawPropsRef.current
    const { effects, newAgentStates, newToolStates } = detectStateChangesPure(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    effectsRef.current.push(...effects)
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates
  }, [])

  // ─── Main draw loop ────────────────────────────────────────────────────

  // Stable ref so the rAF loop always calls the latest draw without
  // re-subscribing when the callback identity changes.
  const drawRef = useRef<(timestamp: number) => void>(() => {})

  const draw = useCallback((timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
    const {
      agents, toolCalls, particles, edges, discoveries,
      selectedAgentId, hoveredAgentId, showStats, showHexGrid,
      showCostOverlay, selectedToolCallId, selectedDiscoveryId,
      simTime, pauseAutoFit, dimensions, onAgentDrag,
      isDragging,
    } = drawPropsRef.current
    const transform = transformRef.current

    const deltaTime = lastFrameTimeRef.current ? (timestamp - lastFrameTimeRef.current) / 1000 : ANIM_SPEED.defaultDeltaTime
    lastFrameTimeRef.current = timestamp
    timeRef.current += deltaTime
    if (simTime != null) simTimeRef.current = simTime

    const dpr = dprRef.current
    const w = dimensions.width
    const h = dimensions.height

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)
    }

    // Camera physics (inertia + auto-fit)
    updateCamera(isDragging, pauseAutoFit)

    // Floaty agent drag
    updateDragLerp(agents, onAgentDrag)

    // Detect state changes → visual effects
    detectStateChanges()

    // Update effects (mutate in place to avoid GC pressure)
    {
      const effects = effectsRef.current
      let writeIdx = 0
      for (let i = 0; i < effects.length; i++) {
        effects[i].age += deltaTime
        if (effects[i].age < effects[i].duration) {
          if (writeIdx !== i) effects[writeIdx] = effects[i]
          writeIdx++
        }
      }
      effects.length = writeIdx
    }

    ctx.clearRect(0, 0, w, h)
    updateDepthParticles(depthParticlesRef.current, deltaTime, w, h)

    let activeAgentPos: { x: number; y: number; color: string } | undefined
    for (const [, agent] of agents) {
      if (agent.state === 'thinking' || agent.state === 'tool_calling' || agent.state === 'waiting_permission') {
        activeAgentPos = { x: agent.x, y: agent.y, color: getStateColor(agent.state) }
        break
      }
    }

    drawBackground(ctx, w, h, depthParticlesRef.current, transform, showHexGrid, timeRef.current, activeAgentPos)

    ctx.save()
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.scale, transform.scale)

    // Pre-compute shared lookup structures — cached across frames when inputs are unchanged
    const elCache = edgeLookupCacheRef.current
    let activeEdgeIds: Set<string>
    let edgeMap: Map<string, Edge>
    if (elCache.particles === particles && elCache.edges === edges) {
      activeEdgeIds = elCache.activeEdgeIds
      edgeMap = elCache.edgeMap
    } else {
      activeEdgeIds = getActiveEdgeIds(particles)
      edgeMap = buildEdgeMap(edges)
      edgeLookupCacheRef.current = { particles, edges, activeEdgeIds, edgeMap }
    }

    drawDiscoveryConnections(ctx, discoveries, agents)
    drawEdges(ctx, edges, agents, toolCalls, activeEdgeIds, timeRef.current)
    drawToolCalls(ctx, toolCalls, timeRef.current, selectedToolCallId)
    drawDiscoveries(ctx, discoveries, agents, selectedDiscoveryId)
    drawAgents(ctx, agents, selectedAgentId, hoveredAgentId, showStats, timeRef.current)
    drawMessageBubblesWorld(ctx, agents, simTimeRef.current)
    if (showCostOverlay) drawCostLabels(ctx, agents, toolCalls)
    drawParticles(ctx, particles, edgeMap, agents, toolCalls, timeRef.current)
    drawEffects(ctx, effectsRef.current)

    if (selectedAgentId) {
      const agent = agents.get(selectedAgentId)
      if (agent) drawTetherLine(ctx, agent, transform, h)
    }

    ctx.restore()

    if (showCostOverlay) drawCostSummaryPanel(ctx, agents, toolCalls)
    if (bloomRef.current) bloomRef.current.apply(canvas, ctx)
    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }, [detectStateChanges, updateCamera, updateDragLerp, transformRef])

  drawRef.current = draw

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRef is stable; rAF loop set up once
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden" style={{ cursor: isDragging ? 'grabbing' : 'grab' }}>
      <canvas
        ref={mainCanvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
        {...handlers}
        className="w-full h-full"
      />
    </div>
  )
}
