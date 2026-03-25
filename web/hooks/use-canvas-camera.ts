import { useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM, NODE } from '@/lib/agent-types'
import { BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_MAX_W, TOOL_CARD_W, TOOL_CARD_H, DISC_BOUNDS_HALF_W, DISC_BOUNDS_HALF_H } from '@/lib/canvas-constants'

/** Extra padding added to agent node radii for auto-fit bounding box */
const AUTOFIT_AGENT_PADDING = 22

export interface Transform {
  x: number
  y: number
  scale: number
}

interface CameraOptions {
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    dimensions: { width: number; height: number }
    selectedAgentId: string | null
    pauseAutoFit?: boolean
    isDragging: boolean
  }>
  simTimeRef: MutableRefObject<number>
  dimensions: { width: number; height: number }
  agentCount: number
  zoomToFitTrigger?: number
  selectedAgentId: string | null
}

export function useCanvasCamera({
  mainCanvasRef,
  drawPropsRef,
  simTimeRef,
  dimensions,
  agentCount,
  zoomToFitTrigger,
  selectedAgentId,
}: CameraOptions) {
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 })
  const userHasNavigatedRef = useRef(false)
  const targetTransformRef = useRef<Transform | null>(null)
  const panVelocityRef = useRef({ vx: 0, vy: 0, active: false })

  // Cache for computeFitTransform — avoids O(n) iteration every frame.
  // Invalidates on collection reference change (React creates new Map/array on state updates).
  const fitCacheRef = useRef<{
    agents: Map<string, Agent> | null
    toolCalls: Map<string, ToolCallNode> | null
    discoveries: Discovery[] | null
    selectedAgentId: string | null
    result: Transform | null
  }>({ agents: null, toolCalls: null, discoveries: null, selectedAgentId: null, result: null })

  // Initialize transform centered on first agents
  useEffect(() => {
    if (agentCount > 0 && transformRef.current.x === 0 && transformRef.current.y === 0) {
      transformRef.current = { x: dimensions.width / 2, y: dimensions.height / 2, scale: 1 }
    }
  }, [agentCount, dimensions])

  // Collect an agent and all its descendants (BFS)
  const getDescendantIds = useCallback((agents: Map<string, Agent>, rootId: string): Set<string> => {
    const ids = new Set<string>([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const parentId = queue.shift()!
      for (const [id, agent] of agents) {
        if (agent.parentId === parentId && !ids.has(id)) {
          ids.add(id)
          queue.push(id)
        }
      }
    }
    return ids
  }, [])

  const computeFitTransform = useCallback((): Transform | null => {
    const { agents, toolCalls, discoveries, dimensions, selectedAgentId } = drawPropsRef.current
    if (agents.size === 0) return null

    // Return cached result if inputs haven't changed (reference equality —
    // React creates new Map/array objects on state updates, so same ref = same data)
    const cache = fitCacheRef.current
    if (cache.agents === agents
      && cache.toolCalls === toolCalls
      && cache.discoveries === discoveries
      && cache.selectedAgentId === selectedAgentId) {
      return cache.result
    }

    // Determine focus scope: if a non-main agent is selected, focus on it + descendants
    let focusScope: Set<string> | null = null
    if (selectedAgentId) {
      const selected = agents.get(selectedAgentId)
      if (selected && !selected.isMain) {
        focusScope = getDescendantIds(agents, selectedAgentId)
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [id, agent] of agents) {
      if (focusScope && !focusScope.has(id)) continue
      const r = (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AUTOFIT_AGENT_PADDING
      minX = Math.min(minX, agent.x - r)
      maxX = Math.max(maxX, agent.x + r)
      minY = Math.min(minY, agent.y - r)
      maxY = Math.max(maxY, agent.y + r)
      if (agent.messageBubbles.length > 0) {
        const visibleCount = agent.messageBubbles.filter(b => {
          const age = (simTimeRef.current ?? 0) - b.time
          return age <= BUBBLE_HOLD + BUBBLE_FADE_OUT
        }).length
        if (visibleCount > 0) {
          maxX = Math.max(maxX, agent.x + r + 14 + BUBBLE_MAX_W * 0.4)
          minX = Math.min(minX, agent.x - r - BUBBLE_MAX_W * 0.2)
          const stackH = visibleCount * 46
          minY = Math.min(minY, agent.y - 20)
          maxY = Math.max(maxY, agent.y - 20 + stackH)
        }
      }
    }
    for (const [, tool] of toolCalls) {
      if (tool.opacity > 0.1 && (!focusScope || focusScope.has(tool.agentId))) {
        const halfW = TOOL_CARD_W / 2
        const halfH = TOOL_CARD_H / 2
        minX = Math.min(minX, tool.x - halfW)
        maxX = Math.max(maxX, tool.x + halfW)
        minY = Math.min(minY, tool.y - halfH)
        maxY = Math.max(maxY, tool.y + halfH)
      }
    }
    for (const disc of discoveries) {
      if (disc.opacity > 0.1 && (!focusScope || focusScope.has(disc.agentId))) {
        minX = Math.min(minX, disc.x - DISC_BOUNDS_HALF_W)
        maxX = Math.max(maxX, disc.x + DISC_BOUNDS_HALF_W)
        minY = Math.min(minY, disc.y - DISC_BOUNDS_HALF_H)
        maxY = Math.max(maxY, disc.y + DISC_BOUNDS_HALF_H)
      }
    }
    if (minX === Infinity) {
      fitCacheRef.current = { agents, toolCalls, discoveries, selectedAgentId, result: null }
      return null
    }
    const padding = ANIM.viewportPadding
    const boundsW = maxX - minX + padding * 2
    const boundsH = maxY - minY + padding * 2
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const scale = Math.min(dimensions.width / boundsW, dimensions.height / boundsH, 2)
    const result = {
      x: dimensions.width / 2 - centerX * scale,
      y: dimensions.height / 2 - centerY * scale,
      scale,
    }
    fitCacheRef.current = { agents, toolCalls, discoveries, selectedAgentId, result }
    return result
  }, [getDescendantIds, drawPropsRef, simTimeRef])

  const doZoomToFit = useCallback(() => {
    userHasNavigatedRef.current = false
    const target = computeFitTransform()
    if (target) targetTransformRef.current = target
  }, [computeFitTransform])

  useEffect(() => {
    if (zoomToFitTrigger && zoomToFitTrigger > 0) doZoomToFit()
  }, [zoomToFitTrigger, doZoomToFit])

  // Re-engage auto-fit when selection changes
  useEffect(() => {
    userHasNavigatedRef.current = false
    targetTransformRef.current = null
  }, [selectedAgentId])

  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const canvas = mainCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (screenX - rect.left - t.x) / t.scale,
      y: (screenY - rect.top - t.y) / t.scale,
    }
  }, [mainCanvasRef])

  /** Call from draw loop to update inertia and auto-fit lerp */
  const updateCamera = useCallback((isDragging: boolean, pauseAutoFit?: boolean) => {
    const transform = transformRef.current

    // Pan inertia
    const inertia = panVelocityRef.current
    if (inertia.active) {
      transformRef.current = { ...transform, x: transform.x + inertia.vx, y: transform.y + inertia.vy }
      inertia.vx *= ANIM.inertiaDecay
      inertia.vy *= ANIM.inertiaDecay
      if (Math.abs(inertia.vx) < 0.1 && Math.abs(inertia.vy) < 0.1) {
        inertia.active = false
      }
    }

    // Auto-fit
    if (!userHasNavigatedRef.current && !isDragging && !pauseAutoFit) {
      const fit = computeFitTransform()
      if (fit) targetTransformRef.current = fit
    }

    // Smooth lerp toward target
    const target = targetTransformRef.current
    if (target) {
      const lerpSpeed = ANIM.autoFitLerp
      const t = transformRef.current
      const nx = t.x + (target.x - t.x) * lerpSpeed
      const ny = t.y + (target.y - t.y) * lerpSpeed
      const ns = t.scale + (target.scale - t.scale) * lerpSpeed
      if (Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001) {
        targetTransformRef.current = null
        transformRef.current = { x: target.x, y: target.y, scale: target.scale }
      } else {
        transformRef.current = { x: nx, y: ny, scale: ns }
      }
    }
  }, [computeFitTransform])

  return {
    transformRef,
    userHasNavigatedRef,
    panVelocityRef,
    screenToCanvas,
    doZoomToFit,
    updateCamera,
  }
}
