'use client'

import { useRef, useEffect, useMemo, useCallback } from 'react'
import { TimelineEntry, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTimelineModels } from '@/lib/timeline-models'
import { PanelHeader, SlidingPanel } from './shared-ui'

interface TimelinePanelProps {
  visible: boolean
  timelineEntries: Map<string, TimelineEntry>
  currentTime: number
  onClose: () => void
}

// ─── Layout constants ────────────────────────────────────────────────────────

const ROW_HEIGHT = 22
const HEADER_HEIGHT = 20
const LABEL_WIDTH = 90
const FONT = '9px monospace'
const MODEL_FONT = '8px monospace'

// ─── Legend (static DOM — no perf cost) ─────────────────────────────────────

const LEGEND_ITEMS = [
  { color: COLORS.idle, label: 'Idle' },
  { color: COLORS.thinking, label: 'Thinking' },
  { color: COLORS.tool, label: 'Tool Call' },
  { color: COLORS.error, label: 'Error' },
  { color: COLORS.complete, label: 'Complete' },
]

// ─── Canvas-based timeline rendering ────────────────────────────────────────

/** Truncate text with '..' so it fits in maxWidth at the current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let end = text.length
  while (end > 1 && ctx.measureText(text.slice(0, end) + '..').width > maxWidth) end--
  return text.slice(0, end) + '..'
}

/** Hover text for a row: the full agent name and every model it used. */
function rowTooltip(entry: TimelineEntry): string {
  const models = formatTimelineModels(entry.models)
  return models ? `${entry.agentName}\n${models}` : entry.agentName
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  entries: TimelineEntry[],
  currentTime: number,
  width: number,
  height: number,
  dpr: number,
) {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)

  if (entries.length === 0) {
    ctx.font = FONT
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'center'
    ctx.fillText('No timeline data', width / 2, height / 2)
    ctx.restore()
    return
  }

  // Compute time range
  let minTime = entries[0].startTime
  let maxTime = currentTime
  for (const e of entries) {
    if (e.startTime < minTime) minTime = e.startTime
    const end = e.endTime ?? currentTime
    if (end > maxTime) maxTime = end
  }
  const timeSpan = Math.max(maxTime - minTime, 1)
  const barWidth = width - LABEL_WIDTH

  // Time markers
  const markerInterval = timeSpan > 60 ? 10 : timeSpan > 20 ? 5 : timeSpan > 10 ? 2 : 1
  const markers: number[] = []
  for (let t = Math.ceil(minTime / markerInterval) * markerInterval; t <= maxTime; t += markerInterval) {
    markers.push(t)
  }

  ctx.font = FONT

  // ── Header row: time labels ──
  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.textMuted
  for (const t of markers) {
    const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
    ctx.fillText(`${t.toFixed(0)}s`, x, HEADER_HEIGHT - 4)
  }

  // ── Agent rows ──
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const y = HEADER_HEIGHT + i * ROW_HEIGHT

    // Agent label, with its models underneath when known
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.textDim
    const name = entry.agentName.length > 12 ? entry.agentName.slice(0, 12) + '..' : entry.agentName
    const models = formatTimelineModels(entry.models)
    if (models) {
      ctx.fillText(name, LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 - 1)
      ctx.font = MODEL_FONT
      ctx.fillStyle = COLORS.textMuted
      ctx.fillText(fitText(ctx, models, LABEL_WIDTH - 8), LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 + 8)
      ctx.font = FONT
    } else {
      ctx.fillText(name, LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 + 3)
    }

    // Background track
    const trackY = y + 4
    const trackH = ROW_HEIGHT - 8
    ctx.fillStyle = COLORS.holoBg03
    ctx.fillRect(LABEL_WIDTH, trackY, barWidth, trackH)

    // Vertical marker lines
    ctx.fillStyle = COLORS.panelSeparator
    for (const t of markers) {
      const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
      ctx.fillRect(x, trackY, 1, trackH)
    }

    // Blocks
    for (const block of entry.blocks) {
      const blockStart = ((block.startTime - minTime) / timeSpan) * barWidth
      const blockEndTime = block.endTime ?? currentTime
      const blockEnd = ((blockEndTime - minTime) / timeSpan) * barWidth
      const blockW = Math.max(blockEnd - blockStart, 1)
      const x = LABEL_WIDTH + blockStart

      // Block fill
      ctx.globalAlpha = 0.3
      ctx.fillStyle = block.color
      ctx.fillRect(x, trackY + 1, blockW, trackH - 2)

      // Block border
      ctx.globalAlpha = 0.2
      ctx.strokeStyle = block.color
      ctx.lineWidth = 1
      ctx.strokeRect(x, trackY + 1, blockW, trackH - 2)

      ctx.globalAlpha = 1

      // Label inside block if wide enough
      if (blockW > 40) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, trackY, blockW, trackH)
        ctx.clip()
        ctx.fillStyle = block.color
        ctx.globalAlpha = 0.8
        ctx.textAlign = 'left'
        ctx.fillText(block.label, x + 4, trackY + trackH / 2 + 3)
        ctx.restore()
      }
    }

    // Playhead
    const playheadX = LABEL_WIDTH + ((currentTime - minTime) / timeSpan) * barWidth
    ctx.fillStyle = COLORS.holoHot
    ctx.globalAlpha = 0.5
    ctx.fillRect(playheadX, trackY, 1, trackH)
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TimelinePanel({ visible, timelineEntries, currentTime, onClose }: TimelinePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const sortedEntries = useMemo(() => {
    if (!visible) return []
    return Array.from(timelineEntries.values()).sort((a, b) => a.startTime - b.startTime)
  }, [visible, timelineEntries])

  const canvasHeight = HEADER_HEIGHT + sortedEntries.length * ROW_HEIGHT

  // Labels are truncated to fit; show the full name and models on hover
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const row = Math.floor((e.nativeEvent.offsetY - HEADER_HEIGHT) / ROW_HEIGHT)
    const entry = row >= 0 ? sortedEntries[row] : undefined
    const title = entry ? rowTooltip(entry) : ''
    if (e.currentTarget.title !== title) e.currentTarget.title = title
  }, [sortedEntries])

  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Use the scroll container's clientWidth (excludes scrollbar) for a snug fit
    const scrollContainer = canvas.parentElement
    const width = scrollContainer?.clientWidth ?? canvas.clientWidth
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${canvasHeight}px`

    drawTimeline(ctx, sortedEntries, currentTime, width, canvasHeight, dpr)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on every prop change (component only re-renders on data/time updates)
  }, [visible, sortedEntries, currentTime, canvasHeight])

  if (!visible) return null

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 72, left: 16, right: 16 }}
      axis="Y"
      zIndex={Z.sidePanel}
      className="mx-auto"
      style={{ maxWidth: 700 }}
    >
      <div className="glass-card relative">
        <PanelHeader onClose={onClose}>
          <span className="text-[10px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            EXECUTION TIMELINE
          </span>
        </PanelHeader>

        <div className="overflow-auto" style={{ maxHeight: 300 }}>
          <canvas ref={canvasRef} style={{ display: 'block' }} onMouseMove={handleMouseMove} />
        </div>

        {/* Legend (static DOM) */}
        <div className="flex items-center gap-3 px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          <div style={{ width: LABEL_WIDTH, flexShrink: 0 }} />
          <div className="flex items-center gap-3">
            {LEGEND_ITEMS.map(item => (
              <div key={item.label} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm" style={{ background: item.color + '70' }} />
                <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SlidingPanel>
  )
}
