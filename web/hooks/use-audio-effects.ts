import { useRef, useState, useEffect, useCallback } from 'react'
import { SOUND_PREF_KEY } from '@/lib/canvas-constants'
import { AudioEngine } from '@/lib/audio-engine'
import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { detectStateChanges } from '@/components/agent-visualizer/canvas/detect-state-changes'

/** More simultaneous transitions than this means history replay, not live activity */
const REPLAY_BURST_THRESHOLD = 3

export function useAudioEffects(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  isReviewing: boolean,
) {
  const audioRef = useRef<AudioEngine | null>(null)
  const [isMuted, setIsMuted] = useState(true)
  const seekingRef = useRef(false)
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())

  // Audio engine lifecycle + restore persisted mute preference
  useEffect(() => {
    const engine = new AudioEngine()
    try {
      const savedOn = localStorage.getItem(SOUND_PREF_KEY) === 'on'
      if (savedOn) {
        engine.setMuted(false)
        setIsMuted(false)
      }
    } catch { /* localStorage unavailable (private browsing, etc.) */ }
    audioRef.current = engine
    return () => { audioRef.current?.dispose(); audioRef.current = null }
  }, [])

  // Detect tool/agent state transitions and play sounds (live mode only)
  useEffect(() => {
    if (seekingRef.current || !audioRef.current || isReviewing) return
    const audio = audioRef.current

    const { transitions, newAgentStates, newToolStates } = detectStateChanges(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    // A burst of transitions means history is being replayed, not live activity — stay quiet
    if (transitions.length > REPLAY_BURST_THRESHOLD) return

    for (const t of transitions) {
      switch (t.kind) {
        case 'agent_spawn':   audio.playAgentSpawn(); break
        case 'agent_complete': audio.playAgentComplete(); break
        case 'tool_start':    audio.playToolStart(); break
        case 'tool_complete': audio.playToolEnd(); break
        case 'tool_error':    audio.playError(); break
      }
    }
  }, [agents, toolCalls, isReviewing])

  const handleToggleMute = useCallback(() => {
    if (audioRef.current) {
      const nowMuted = audioRef.current.toggleMute()
      setIsMuted(nowMuted)
      try { localStorage.setItem(SOUND_PREF_KEY, nowMuted ? 'off' : 'on') } catch { /* ignore */ }
    }
  }, [])

  return { isMuted, seekingRef, handleToggleMute }
}
