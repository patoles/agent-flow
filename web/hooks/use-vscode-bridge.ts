'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'

interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view. Optional fromIndex to skip already-processed events. */
  selectSession: (sessionId: string | null, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
}

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [useMockData, setUseMockData] = useState(true)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
      }

      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(simEvent)
        sessionEventsRef.current.set(event.sessionId, buf)
      }

      // Deliver to pending if session matches (ref is always current)
      const selected = selectedSessionIdRef.current
      if (selected && event.sessionId === selected) {
        pendingEventsRef.current.push(simEvent)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && event.sessionId !== selected) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          setSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      setUseMockData(config.showMockData)
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state
        setSessions([])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        sessionEventsRef.current.clear()
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        setEventVersion(v => v + 1)
        return
      }
      if (type === 'list') {
        const sessionList = data as SessionInfo[]
        setSessions(sessionList)
        // Auto-select: prefer active sessions, then most recently active
        if (!selectedSessionIdRef.current && sessionList.length > 0) {
          const sorted = [...sessionList].sort((a, b) => {
            const aActive = a.status === 'active' ? 1 : 0
            const bActive = b.status === 'active' ? 1 : 0
            if (aActive !== bActive) return bActive - aActive
            return b.lastActivityTime - a.lastActivityTime
          })
          const autoId = sorted[0].id
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
          // Flush any events already buffered for this session
          const buffered = sessionEventsRef.current.get(autoId)
          if (buffered && buffered.length > 0) {
            pendingEventsRef.current.length = 0
            pendingEventsRef.current.push(...buffered)
            setEventVersion(v => v + 1)
          }
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        setSessions(prev => {
          const existing = prev.find(s => s.id === session.id)
          if (existing) {
            // Session resumed after inactivity — mark active again
            return prev.map(s => s.id === session.id
              ? { ...s, status: 'active' as const, lastActivityTime: Date.now() }
              : s)
          }
          return [...prev, session]
        })
        // Auto-select newly started session
        selectedSessionIdRef.current = session.id
        setSelectedSessionId(session.id)
      } else if (type === 'updated') {
        const { sessionId, label } = data as { sessionId: string; label: string }
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, label } : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  const selectSession = useCallback((sessionId: string | null, fromIndex = 0) => {
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      // Flush buffered events for the new session into pending
      // Clear in-place then push to preserve array identity for stale closures
      const buffered = sessionEventsRef.current.get(sessionId) || []
      pendingEventsRef.current.length = 0
      pendingEventsRef.current.push(...buffered.slice(fromIndex))
      setEventVersion(v => v + 1)
      // Clear activity indicator for selected session
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    getSessionEventCount,
    sessionsWithActivity,
    removeSession,
  }
}
