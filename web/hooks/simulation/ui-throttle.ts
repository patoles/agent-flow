/** ms between React state updates — canvas uses frameRef for smooth 60fps */
export const UI_THROTTLE_MS = 250

/**
 * Whether the animation loop should push the current frame to React state.
 *
 * The canvas reads frameRef every frame, but the control bar (elapsed time,
 * scrubber knob) and counters only update on a React render. Render when
 * events were processed, or when the clock crossed a whole second so the
 * mm:ss label keeps moving through quiet stretches of the timeline. Both are
 * throttled to UI_THROTTLE_MS.
 */
export function shouldCommitFrame(opts: {
  now: number
  lastCommitAt: number
  processedEvents: boolean
  currentTime: number
  lastCommittedTime: number
}): boolean {
  if (opts.lastCommitAt && opts.now - opts.lastCommitAt < UI_THROTTLE_MS) return false
  return opts.processedEvents || Math.floor(opts.currentTime) !== Math.floor(opts.lastCommittedTime)
}
