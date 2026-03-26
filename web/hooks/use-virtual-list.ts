import { useState, useCallback, useRef, useEffect } from 'react'
import { AUTO_SCROLL_THRESHOLD } from '@/lib/canvas-constants'

const OVERSCAN = 10

interface UseVirtualListOptions {
  gap: number
  initialViewportHeight?: number
  autoScroll?: boolean
}

/**
 * Virtual list with exact measurement — no height estimation.
 *
 * Items are rendered and measured on mount. Only measured heights contribute
 * to totalHeight and positioning. New items are always rendered (via an
 * extended render window) so they get measured immediately.
 */
export function useVirtualList<T extends { id: string }>(
  items: readonly T[],
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseVirtualListOptions,
) {
  const { gap, initialViewportHeight = 300, autoScroll = false } = options
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight)
  const [measureTick, setMeasureTick] = useState(0)
  const heightsRef = useRef<Map<string, number>>(new Map())
  const autoScrollRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Reset when items go from empty to populated (panel reopen)
  const wasEmptyRef = useRef(true)
  if (items.length === 0) {
    wasEmptyRef.current = true
  } else if (wasEmptyRef.current) {
    wasEmptyRef.current = false
    heightsRef.current.clear()
    autoScrollRef.current = true
  }

  const isPinned = autoScroll && autoScrollRef.current

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (autoScroll) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD
      autoScrollRef.current = atBottom
      setIsAtBottom(atBottom)
      if (atBottom) return
    }
    setScrollTop(el.scrollTop)
  }, [containerRef, autoScroll])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  // ── Layout: only use measured heights ─────────────────────────────────────
  const heights = heightsRef.current
  let totalHeight = 0
  const offsets: number[] = []
  for (const item of items) {
    offsets.push(totalHeight)
    const h = heights.get(item.id)
    if (h != null) totalHeight += h + gap
    // Unmeasured items: offset stays at current totalHeight (stacked at end),
    // height = 0 in totalHeight until measured
  }

  // ── Visible window ────────────────────────────────────────────────────────
  // Read scrollTop directly from DOM to avoid stale-state lag
  const liveScrollTop = (!isPinned && containerRef.current)
    ? containerRef.current.scrollTop
    : scrollTop

  let startIdx: number
  let endIdx: number

  if (isPinned && items.length > 0) {
    // Pinned: render from the end
    endIdx = items.length
    let filled = 0
    startIdx = items.length
    for (let i = items.length - 1; i >= 0; i--) {
      const h = heights.get(items[i].id)
      if (h != null) filled += h + gap
      startIdx = i
      if (filled > viewportHeight + 200) break // extra buffer
    }
    startIdx = Math.max(0, startIdx - OVERSCAN)
  } else {
    // Normal scroll: find first item whose bottom edge is past scrollTop
    let lo = 0
    for (lo = 0; lo < items.length; lo++) {
      const h = heights.get(items[lo].id)
      if (h == null) continue // unmeasured items have no height yet — keep looking
      if (offsets[lo] + h + gap >= liveScrollTop) break
    }
    startIdx = Math.max(0, lo - OVERSCAN)

    // Find last item whose top edge is before viewport bottom
    endIdx = startIdx
    for (let i = lo; i < items.length; i++) {
      const h = heights.get(items[i].id)
      endIdx = i + 1
      if (h != null && offsets[i] > liveScrollTop + viewportHeight) {
        endIdx = Math.min(items.length, i + OVERSCAN + 1)
        break
      }
    }
    endIdx = Math.min(items.length, Math.max(endIdx, startIdx + OVERSCAN + 1))
  }

  // Always render unmeasured items at the end so they get measured
  for (let i = endIdx; i < items.length; i++) {
    if (!heights.has(items[i].id)) endIdx = i + 1
    else break
  }

  const visibleItems = items.slice(startIdx, endIdx)
  const offsetTop = startIdx < offsets.length ? offsets[startIdx] : 0

  // ── Trigger re-render after measurements ──────────────────────────────────
  const measureRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (!el) return
    const h = el.offsetHeight
    if (heights.get(id) !== h) {
      heights.set(id, h)
      // Force re-render to recalculate layout with real heights
      setMeasureTick(n => n + 1)
    }
  }, [heights])

  // ── Auto-scroll after layout settles ──────────────────────────────────────
  useEffect(() => {
    if (autoScroll && autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [autoScroll, containerRef, items.length, measureTick])

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      autoScrollRef.current = true
      setIsAtBottom(true)
    }
  }, [containerRef])

  return {
    visibleItems, totalHeight, offsetTop,
    handleScroll, measureRef,
    isAtBottom, scrollToBottom,
  }
}
