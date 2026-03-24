'use client'

import { TimelineEntry, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { PanelHeader, SlidingPanel } from './shared-ui'

interface TimelinePanelProps {
  visible: boolean
  timelineEntries: Map<string, TimelineEntry>
  currentTime: number
  onClose: () => void
  onSeek?: (time: number) => void
}

export function TimelinePanel({ visible, timelineEntries, currentTime, onClose, onSeek }: TimelinePanelProps) {
  const entries = Array.from(timelineEntries.values())
    .sort((a, b) => a.startTime - b.startTime)

  // Compute time range (avoid spread on large arrays to prevent stack overflow)
  let minTime = entries.length > 0 ? entries[0].startTime : 0
  let maxTime = currentTime
  for (const e of entries) {
    if (e.startTime < minTime) minTime = e.startTime
    const end = e.endTime ?? currentTime
    if (end > maxTime) maxTime = end
  }
  const timeSpan = Math.max(maxTime - minTime, 1)

  const rowHeight = 22
  const headerHeight = 20
  const labelWidth = 90
  const barAreaWidth = 400 // will scale to fit

  // Time markers
  const markerInterval = timeSpan > 20 ? 5 : timeSpan > 10 ? 2 : 1
  const markers: number[] = []
  for (let t = Math.ceil(minTime / markerInterval) * markerInterval; t <= maxTime; t += markerInterval) {
    markers.push(t)
  }

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 64, left: 16, right: 16 }}
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

        <div className="overflow-x-auto">
          <div style={{ minWidth: labelWidth + barAreaWidth }}>
            {/* Time markers header */}
            <div className="flex" style={{ height: headerHeight }}>
              <div style={{ width: labelWidth, flexShrink: 0 }} />
              <div
                className="flex-1 relative"
                style={{ cursor: onSeek ? 'pointer' : undefined }}
                onClick={onSeek ? (e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                  onSeek(minTime + fraction * timeSpan)
                } : undefined}
              >
                {markers.map(t => {
                  const left = ((t - minTime) / timeSpan) * 100
                  return (
                    <div
                      key={t}
                      className="absolute text-[9px] font-mono"
                      style={{
                        left: `${left}%`,
                        top: 4,
                        transform: 'translateX(-50%)',
                        color: COLORS.textMuted,
                      }}
                    >
                      {t.toFixed(0)}s
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Agent rows */}
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center" style={{ height: rowHeight }}>
                {/* Agent label */}
                <div
                  className="text-[9px] font-mono truncate pr-2"
                  style={{ width: labelWidth, flexShrink: 0, color: COLORS.textDim, textAlign: 'right' }}
                >
                  {entry.agentName}
                </div>

                {/* Blocks bar */}
                <div
                  className="flex-1 relative"
                  style={{ height: 14, cursor: onSeek ? 'pointer' : undefined }}
                  onClick={onSeek ? (e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                    onSeek(minTime + fraction * timeSpan)
                  } : undefined}
                >
                  {/* Background track */}
                  <div
                    className="absolute inset-0 rounded-sm"
                    style={{ background: COLORS.holoBg03 }}
                  />

                  {/* Time markers (vertical lines) */}
                  {markers.map(t => {
                    const left = ((t - minTime) / timeSpan) * 100
                    return (
                      <div
                        key={t}
                        className="absolute top-0 bottom-0"
                        style={{
                          left: `${left}%`,
                          width: 1,
                          background: COLORS.panelSeparator,
                        }}
                      />
                    )
                  })}

                  {/* Blocks */}
                  {entry.blocks.map((block) => {
                    const blockStart = ((block.startTime - minTime) / timeSpan) * 100
                    const blockEnd = block.endTime
                      ? ((block.endTime - minTime) / timeSpan) * 100
                      : ((currentTime - minTime) / timeSpan) * 100
                    const blockWidth = Math.max(blockEnd - blockStart, 0.5)

                    return (
                      <div
                        key={block.id}
                        className="absolute top-0.5 bottom-0.5 rounded-sm"
                        style={{
                          left: `${blockStart}%`,
                          width: `${blockWidth}%`,
                          background: block.color + '50',
                          border: `1px solid ${block.color}30`,
                          overflow: 'hidden',
                        }}
                        title={block.label}
                      >
                        {/* Label inside block if wide enough */}
                        {blockWidth > 5 && (
                          <span
                            className="absolute inset-0 flex items-center px-1 text-[9px] font-mono truncate"
                            style={{ color: block.color + 'cc' }}
                          >
                            {block.label}
                          </span>
                        )}
                      </div>
                    )
                  })}

                  {/* Current time playhead */}
                  <div
                    className="absolute top-0 bottom-0"
                    style={{
                      left: `${((currentTime - minTime) / timeSpan) * 100}%`,
                      width: 1,
                      background: COLORS.holoHot,
                      opacity: 0.5,
                    }}
                  />
                </div>
              </div>
            ))}

            {/* Legend */}
            <div className="flex items-center gap-3 mt-2 pt-1" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
              <div style={{ width: labelWidth, flexShrink: 0 }} />
              <div className="flex items-center gap-3">
                {[
                  { color: COLORS.idle, label: 'Idle' },
                  { color: COLORS.thinking, label: 'Thinking' },
                  { color: COLORS.tool, label: 'Tool Call' },
                  { color: COLORS.error, label: 'Error' },
                  { color: COLORS.complete, label: 'Complete' },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm" style={{ background: item.color + '70' }} />
                    <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SlidingPanel>
  )
}
