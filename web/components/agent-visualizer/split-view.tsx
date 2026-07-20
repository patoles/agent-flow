'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { SessionPane, type PaneBridge } from './session-pane'
import type { SessionInfo } from '@/lib/bridge-types'

/** Hard cap on simultaneous panes — each runs its own simulation + canvas rAF
 *  loop, so more than this starves the frame budget. Extra sessions are dropped
 *  (with a visible notice) rather than silently animating off-screen. */
export const MAX_PANES = 4

interface SplitViewProps {
  /** Sessions to show as panes (already filtered by project/worktree upstream). */
  sessions: SessionInfo[]
  bridge: PaneBridge
}

const clampFraction = (f: number) => Math.min(0.85, Math.max(0.15, f))

/**
 * Resizable grid of {@link SessionPane}s — the split view. Lays panes out in a
 * 1×N / 2×2 grid (capped at {@link MAX_PANES}) with draggable dividers, no
 * external layout library. One pane is "focused" at a time so only it emits audio.
 */
export function SplitView({ sessions, bridge }: SplitViewProps) {
  const panes = sessions.slice(0, MAX_PANES)
  const dropped = sessions.length - panes.length

  const cols = panes.length <= 1 ? 1 : 2
  const rows = panes.length <= 2 ? 1 : 2

  const [colFraction, setColFraction] = useState(0.5)
  const [rowFraction, setRowFraction] = useState(0.5)
  const [focusedId, setFocusedId] = useState<string | null>(panes[0]?.id ?? null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<'col' | 'row' | null>(null)

  // Keep a valid focus target as panes come and go.
  useEffect(() => {
    if (panes.length === 0) { if (focusedId !== null) setFocusedId(null); return }
    if (!focusedId || !panes.some(p => p.id === focusedId)) setFocusedId(panes[0].id)
  }, [panes, focusedId])

  // Divider drag — track pointer against the container box, compute a fraction.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const kind = dragRef.current
      const box = containerRef.current
      if (!kind || !box) return
      const rect = box.getBoundingClientRect()
      if (kind === 'col') setColFraction(clampFraction((e.clientX - rect.left) / rect.width))
      else setRowFraction(clampFraction((e.clientY - rect.top) / rect.height))
    }
    const onUp = () => {
      if (dragRef.current) { dragRef.current = null; document.body.style.userSelect = '' }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const startDrag = useCallback((kind: 'col' | 'row') => (e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = kind
    document.body.style.userSelect = 'none'
  }, [])

  const rowOf = useCallback((paneList: SessionInfo[]) => (
    <div className="flex flex-row min-h-0 h-full w-full">
      {paneList.map((session, i) => (
        <ColCell
          key={session.id}
          grow={cols === 2 ? (i === 0 ? colFraction : 1 - colFraction) : 1}
          showDivider={cols === 2 && i === 0}
          onDividerDown={startDrag('col')}
        >
          <SessionPane
            sessionId={session.id}
            session={session}
            bridge={bridge}
            focused={session.id === focusedId}
            onFocus={setFocusedId}
          />
        </ColCell>
      ))}
    </div>
  ), [bridge, colFraction, cols, focusedId, startDrag])

  const [topRow, bottomRow] = useMemo(() => {
    if (rows === 1) return [panes, [] as SessionInfo[]]
    return [panes.slice(0, 2), panes.slice(2)]
  }, [panes, rows])

  return (
    <div ref={containerRef} className="absolute inset-0 flex flex-col" style={{ background: COLORS.void }}>
      <div className="flex min-w-0" style={{ flex: `${rows === 2 ? rowFraction : 1} 1 0`, minHeight: 0 }}>
        {rowOf(topRow)}
      </div>

      {rows === 2 && (
        <div
          onPointerDown={startDrag('row')}
          className="w-full shrink-0"
          style={{ height: 6, cursor: 'row-resize', background: COLORS.holoBorder06 }}
          title="Drag to resize"
        />
      )}

      {rows === 2 && (
        <div className="flex min-w-0" style={{ flex: `${1 - rowFraction} 1 0`, minHeight: 0 }}>
          {rowOf(bottomRow)}
        </div>
      )}

      {dropped > 0 && (
        <div
          className="absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-[10px] px-2 py-1 rounded pointer-events-none"
          style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder06}`, color: COLORS.textMuted }}
        >
          +{dropped} session{dropped > 1 ? 's' : ''} hidden — narrow the project/worktree filter (max {MAX_PANES} panes)
        </div>
      )}
    </div>
  )
}

/** One column cell within a row, plus its right-edge resize handle. */
function ColCell({ grow, showDivider, onDividerDown, children }: {
  grow: number
  showDivider: boolean
  onDividerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="min-w-0 h-full" style={{ flex: `${grow} 1 0` }}>
        {children}
      </div>
      {showDivider && (
        <div
          onPointerDown={onDividerDown}
          className="shrink-0 h-full"
          style={{ width: 6, cursor: 'col-resize', background: COLORS.holoBorder06 }}
          title="Drag to resize"
        />
      )}
    </>
  )
}
