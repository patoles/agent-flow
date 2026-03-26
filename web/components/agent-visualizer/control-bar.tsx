'use client'

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { TimelineEvent, Z, POPUP, TIMING } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'

interface ControlBarProps {
  isPlaying: boolean
  speed: number
  currentTime: number
  totalDuration: number
  onPlayPause: () => void
  onRestart: () => void
  onSpeedChange: (speed: number) => void
  onSeek?: (time: number) => void
  timelineEvents: TimelineEvent[]
  isReviewing?: boolean
  eventCount?: number
  onResumeLive?: () => void
  onEnterReview?: () => void
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getEventColor(type: TimelineEvent['type']): string {
  switch (type) {
    case 'thinking': return COLORS.thinking
    case 'tool_call': return COLORS.tool
    case 'tool_result': return COLORS.return
    case 'message': return COLORS.message
    case 'error': return COLORS.error
    default: return COLORS.idle
  }
}

/** Max event marker dots rendered on the scrubber (prevents DOM bloat) */
const MAX_SCRUBBER_DOTS = 120

/** Shared event marker dots on the scrubber track.
 *  Memoized to avoid re-rendering every frame when only currentTime changes in the parent. */
const EventMarkers = memo(function EventMarkers({ events, totalDuration, className = '' }: {
  events: TimelineEvent[]
  totalDuration: number
  className?: string
  /** Pass events.length to bust memo when array is mutated in place */
  eventCount?: number
}) {
  // Down-sample to MAX_SCRUBBER_DOTS evenly spaced events when list is large
  const visible = events.length > MAX_SCRUBBER_DOTS
    ? Array.from({ length: MAX_SCRUBBER_DOTS }, (_, i) => events[Math.floor(i * events.length / MAX_SCRUBBER_DOTS)])
    : events
  // Position dots relative to the last event so they always span the full bar,
  // rather than compressing into a fraction when currentTime runs ahead of events
  const lastEventTime = events.length > 0 ? events[events.length - 1].timestamp : 0
  const effectiveDuration = lastEventTime > 0 ? lastEventTime : totalDuration
  return (
    <>
      {visible.map((event) => {
        const pos = effectiveDuration > 0 ? (event.timestamp / effectiveDuration) * 100 : 0
        if (pos < 0 || pos > 100) return null
        return (
          <div
            key={event.id}
            className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full ${className}`}
            style={{ left: `${pos}%`, background: getEventColor(event.type) }}
          />
        )
      })}
    </>
  )
})

/** Hook to cache the full set of timeline events (dots don't disappear when seeking backward) */
function useScrubberEvents(timelineEvents: TimelineEvent[], totalDuration: number) {
  const fullEventsRef = useRef<TimelineEvent[]>([])
  if (timelineEvents.length === 0 && totalDuration < 0.1) {
    fullEventsRef.current = []
  } else if (timelineEvents.length >= fullEventsRef.current.length) {
    fullEventsRef.current = timelineEvents
  }
  return fullEventsRef.current
}

export function ControlBar(props: ControlBarProps) {
  const { isReviewing = false } = props
  return isReviewing ? <ReviewControlBar {...props} /> : <LiveControlBar {...props} />
}

// ─── Live Mode Control Bar ───────────────────────────────────────────────────

function LiveControlBar({
  currentTime, totalDuration, timelineEvents,
  eventCount = 0, onEnterReview, isReviewing,
}: ControlBarProps) {
  const [pulseOn, setPulseOn] = useState(true)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)

  useEffect(() => {
    if (isReviewing) return
    const interval = setInterval(() => setPulseOn(p => !p), TIMING.livePulseMs)
    return () => clearInterval(interval)
  }, [isReviewing])

  return (
    <div
      className="absolute bottom-4 left-4 right-4 mx-auto"
      style={{ pointerEvents: 'auto', maxWidth: POPUP.controlBarMaxWidth, zIndex: Z.controlBar }}
    >
      <div className="glass-card px-5 py-3 flex items-center gap-3">
        {/* LIVE badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className="w-2 h-2 rounded-full transition-opacity duration-500"
            style={{
              background: COLORS.liveDot,
              boxShadow: pulseOn ? `0 0 8px ${COLORS.liveDot}, 0 0 16px rgba(255,68,68,0.3)` : `0 0 4px ${COLORS.liveDot}80`,
              opacity: pulseOn ? 1 : 0.6,
            }}
          />
          <span className="text-[10px] font-mono font-semibold tracking-wider" style={{ color: COLORS.liveText }}>
            LIVE
          </span>
        </div>

        {/* Time */}
        <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary }}>
          {formatTime(currentTime)}
        </span>

        {/* Read-only event track */}
        <div className="flex-1 relative h-6 flex items-center">
          <div
            className="w-full rounded-full relative"
            style={{ height: 3, background: COLORS.holoBg10 }}
          >
            <EventMarkers events={scrubberEvents} totalDuration={totalDuration} eventCount={scrubberEvents.length} className="opacity-80" />
          </div>
        </div>

        {/* Event count */}
        <span className="text-[10px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
          {eventCount}
        </span>

        {/* Review button */}
        <button
          onClick={onEnterReview}
          className="px-2.5 py-1 rounded text-[10px] font-mono transition-all hover:scale-105"
          style={{
            background: COLORS.holoBg10,
            border: `1px solid ${COLORS.reviewBtnBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          ⏸ Review
        </button>
      </div>
    </div>
  )
}

// ─── Review Mode Control Bar ─────────────────────────────────────────────────

const SPEEDS = [0.5, 1, 2, 4] as const

function ReviewControlBar({
  isPlaying, speed, currentTime, totalDuration,
  onPlayPause, onRestart, onSpeedChange, onSeek,
  timelineEvents, isReviewing, onResumeLive,
}: ControlBarProps) {
  const scrubberRef = useRef<HTMLDivElement>(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)
  const progress = totalDuration > 0 ? currentTime / totalDuration : 0

  const scrubToClientX = useCallback((clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect || !onSeek) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onSeek(ratio * totalDuration)
  }, [onSeek, totalDuration])

  useEffect(() => {
    if (!isScrubbing) return
    const handleMove = (e: MouseEvent) => scrubToClientX(e.clientX)
    const handleUp = () => setIsScrubbing(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isScrubbing, scrubToClientX])

  return (
    <div
      className="absolute bottom-4 left-4 right-4 mx-auto"
      style={{ pointerEvents: 'auto', maxWidth: POPUP.controlBarMaxWidth, zIndex: Z.controlBar }}
    >
      <div className="glass-card px-5 py-3 flex items-center gap-3">
        {/* Play/Pause */}
        <button
          onClick={onPlayPause}
          className="w-9 h-9 rounded-full flex items-center justify-center transition-all shrink-0 hover:scale-110"
          style={{
            background: isPlaying ? COLORS.playBtnActiveBg : COLORS.playBtnBg,
            border: `1.5px solid ${COLORS.playBtnBorder}`,
            boxShadow: COLORS.playBtnGlow,
          }}
        >
          <span style={{ color: COLORS.textPrimary, fontSize: 14, marginLeft: isPlaying ? 0 : 2 }}>
            {isPlaying ? '⏸' : '▶'}
          </span>
        </button>

        {/* Time */}
        <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary, minWidth: 42 }}>
          {formatTime(currentTime)}
        </span>

        {/* Timeline scrubber */}
        <div
          ref={scrubberRef}
          className="flex-1 relative h-8 flex items-center group cursor-pointer"
          onMouseDown={(e) => {
            e.preventDefault()
            setIsScrubbing(true)
            scrubToClientX(e.clientX)
          }}
        >
          <div
            className="w-full rounded-full relative transition-all duration-150 group-hover:h-2"
            style={{ height: isScrubbing ? 8 : 4, background: COLORS.glassBorder }}
          >
            {/* Progress fill */}
            <div
              className="h-full rounded-full transition-[width]"
              style={{
                width: `${progress * 100}%`,
                background: COLORS.scrubberFill,
              }}
            />
            <EventMarkers
              events={scrubberEvents}
              totalDuration={totalDuration}
              eventCount={scrubberEvents.length}
              className="opacity-60 group-hover:opacity-100 transition-opacity"
            />
          </div>

          {/* Playhead */}
          <div
            className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-150 group-hover:w-4 group-hover:h-4"
            style={{
              left: `${progress * 100}%`,
              width: isScrubbing ? 16 : 12,
              height: isScrubbing ? 16 : 12,
              marginLeft: isScrubbing ? -8 : -6,
              background: COLORS.textPrimary,
              boxShadow: COLORS.scrubberHeadGlow,
            }}
          />
        </div>

        {/* Duration */}
        <span className="text-[10px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
          {formatTime(totalDuration)}
        </span>

        {/* Speed controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              className="px-2 py-0.5 rounded text-[10px] font-mono transition-all"
              style={{
                background: speed === s ? COLORS.playBtnActiveBg : 'transparent',
                color: speed === s ? COLORS.textPrimary : COLORS.textMuted,
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Resume Live */}
        {isReviewing && (
          <button
            onClick={onResumeLive}
            className="px-2.5 py-1 rounded text-[10px] font-mono font-semibold transition-all hover:scale-105 shrink-0"
            style={{
              background: COLORS.liveResumeBg,
              border: `1px solid ${COLORS.liveResumeBorder}`,
              color: COLORS.liveText,
            }}
          >
            ▶ LIVE
          </button>
        )}

        {/* Restart */}
        {isReviewing && (
          <button
            onClick={onRestart}
            className="text-sm transition-all shrink-0 hover:scale-110"
            style={{ color: COLORS.textDim }}
          >
            ⟲
          </button>
        )}
      </div>
    </div>
  )
}
