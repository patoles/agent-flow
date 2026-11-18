'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface ExportOptions {
  getCanvas: () => HTMLCanvasElement | null
  getAudioStream: () => MediaStream | null
  /** Current simulation time (seconds) */
  getCurrentTime: () => number
  getMaxTime: () => number
  /** Sim time of the next event still to be replayed, or null when caught up */
  getNextEventTime: () => number | null
  seekToTime: (t: number) => void
  skipTo: (t: number) => void
  play: () => void
  pause: () => void
  setOverlay: (text: string | null) => void
  onDone?: () => void
}

/** Idle stretches longer than this (sim seconds) are replaced by a caption card */
const GAP_SKIP_S = 10
/** How long the caption card stays on screen (real ms) */
const GAP_CARD_MS = 2000

function formatGap(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Extra recording after the last event so the final animations land in the file */
const TAIL_MS = 1500
const FPS = 30

/** Pick the best container the browser can encode; MP4 (H.264/AAC) where available, else WebM */
function pickMimeType(): { mime: string; ext: string } {
  const candidates: Array<[string, string]> = [
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm', 'webm'],
  ]
  for (const [mime, ext] of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return { mime, ext }
  }
  return { mime: '', ext: 'webm' }
}

/**
 * Records the whole timeline (from t=0 to the last event) as a video with the
 * simulation's sounds, by replaying it in real time through a MediaRecorder
 * fed from canvas.captureStream() + the AudioEngine's recording output.
 * Playback speed is whatever the simulation is set to. A second click stops
 * early and saves the partial recording.
 */
/** Save a blob: native "Save as" dialog where available (user picks folder + name), otherwise a download */
async function saveBlob(blob: Blob, suggestedName: string, ext: string): Promise<string> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: ext.toUpperCase() + ' video', accept: { [blob.type || `video/${ext}`]: [`.${ext}`] } }],
      })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      return `Saved as ${handle.name}`
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return 'Export cancelled (not saved)'
      // Picker unavailable in this context — fall through to a plain download
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return `Saved ${suggestedName} to your browser's Downloads folder`
}

export function useTimelineExport(opts: ExportOptions) {
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  /** Human-readable outcome of the last export, cleared after a few seconds */
  const [lastResult, setLastResult] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const rafRef = useRef(0)
  const discardRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const stop = useCallback((discard: boolean) => {
    discardRef.current = discard
    cancelAnimationFrame(rafRef.current)
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    optsRef.current.setOverlay(null)
  }, [])

  const start = useCallback(() => {
    const o = optsRef.current
    const canvas = o.getCanvas()
    if (!canvas || typeof MediaRecorder === 'undefined' || !('captureStream' in canvas)) {
      alert('Recording is not supported in this browser')
      return
    }
    const { mime, ext } = pickMimeType()
    const stream = canvas.captureStream(FPS)
    const audio = o.getAudioStream()
    for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track)

    const chunks: Blob[] = []
    const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 6_000_000 })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop()
      recorderRef.current = null
      setIsExporting(false)
      setProgress(0)
      if (!discardRef.current && chunks.length > 0) {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime })
        const name = `agent-flow-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`
        saveBlob(blob, name, ext).then(msg => {
          setLastResult(`${msg} (${(blob.size / 1_048_576).toFixed(1)} MB)`)
          setTimeout(() => setLastResult(null), 12_000)
        })
      }
      optsRef.current.onDone?.()
    }
    recorderRef.current = recorder
    discardRef.current = false
    setIsExporting(true)
    setProgress(0)

    // Replay from the beginning while recording
    o.seekToTime(0)
    o.play()
    recorder.start(1000)

    let tailTimer: ReturnType<typeof setTimeout> | null = null
    let skipping = false
    const tick = () => {
      const o = optsRef.current
      const cur = o.getCurrentTime()
      const max = Math.max(o.getMaxTime(), 0.001)
      setProgress(Math.min(1, cur / max))
      if (cur >= max) {
        if (!tailTimer) tailTimer = setTimeout(() => stop(false), TAIL_MS)
        return
      }
      // Idle gap ahead: freeze, show the caption card for a moment, then jump to the next event
      const next = o.getNextEventTime()
      if (!skipping && next !== null && next - cur > GAP_SKIP_S) {
        skipping = true
        o.pause()
        o.setOverlay(`… ${formatGap(next - cur)} later …`)
        setTimeout(() => {
          optsRef.current.setOverlay(null)
          optsRef.current.skipTo(next - 0.5)
          optsRef.current.play()
          skipping = false
        }, GAP_CARD_MS)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stop])

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); recorderRef.current?.stop() }, [])

  /** Stop early and save what was recorded so far */
  return { isExporting, progress, lastResult, startExport: start, stopExport: () => stop(false) }
}
