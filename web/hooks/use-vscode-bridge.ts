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
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
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
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return

    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')

    es.onopen = () => {
      setConnectionStatus('connected')
      setUseMockData(false)
    }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        // In standalone mode, process SSE messages directly without postMessage
        // postMessage to self doesn't work reliably in same-origin context
        if (data.type === 'agent-event' && data.event) {
          const eventData = data as { type: string; event: AgentEvent }
          const simEvent: SimulationEvent = {
            time: eventData.event.time,
            type: eventData.event.type as SimulationEvent['type'],
            payload: eventData.event.payload,
            sessionId: eventData.event.sessionId,
          }

          let selected = selectedSessionIdRef.current

          // Auto-select session if none is selected and event has sessionId
          if (!selected && eventData.event.sessionId) {
            sessionSwitchPendingRef.current = true
            pendingEventsRef.current.length = 0
            selectedSessionIdRef.current = eventData.event.sessionId
            selected = eventData.event.sessionId
            setSelectedSessionId(eventData.event.sessionId)
            // Create a session entry if it doesn't exist
            setSessions(prev => {
              const exists = prev.find(s => s.id === eventData.event.sessionId)
              if (exists) return prev
              return [...prev, {
                id: eventData.event.sessionId!,
                label: `Session ${eventData.event.sessionId!.slice(0, 8)}`,
                status: 'active' as const,
                startTime: Date.now(),
                lastActivityTime: Date.now(),
              }]
            })
          }

          if (selected && eventData.event.sessionId === selected && !sessionSwitchPendingRef.current) {
            pendingEventsRef.current.push(simEvent)
            setEventVersion(v => v + 1)
          } else if (eventData.event.sessionId && eventData.event.sessionId !== selected) {
            setSessionsWithActivity(prev => {
              if (prev.has(eventData.event.sessionId!)) return prev
              const next = new Set(prev)
              next.add(eventData.event.sessionId!)
              return next
            })
          }

          // Buffer by session for replay
          if (eventData.event.sessionId) {
            const buf = sessionEventsRef.current.get(eventData.event.sessionId) || []
            buf.push(simEvent)
            sessionEventsRef.current.set(eventData.event.sessionId, buf)
          }
        } else if (data.type === 'session-list' && data.sessions) {
          setSessions(data.sessions)
          if (!selectedSessionIdRef.current && data.sessions.length > 0) {
            const sorted = [...data.sessions].sort((a, b) => {
              const aActive = a.status === 'active' ? 1 : 0
              const bActive = b.status === 'active' ? 1 : 0
              if (aActive !== bActive) return bActive - aActive
              return b.lastActivityTime - a.lastActivityTime
            })
            sessionSwitchPendingRef.current = true
            pendingEventsRef.current.length = 0
            selectedSessionIdRef.current = sorted[0].id
            setSelectedSessionId(sorted[0].id)
          }
        } else if (data.type === 'session-started' && data.session) {
          setSessions(prev => {
            const existing = prev.find(s => s.id === data.session.id)
            if (existing) return prev.map(s => s.id === data.session.id ? { ...s, status: 'active' as const, lastActivityTime: Date.now() } : s)
            return [...prev, data.session]
          })
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = data.session.id
          setSelectedSessionId(data.session.id)
        } else if (data.type === 'session-ended') {
          setSessions(prev => prev.map(s => s.id === data.sessionId ? { ...s, status: 'completed' as const } : s))
        } else if (data.type === 'session-updated') {
          setSessions(prev => prev.map(s => s.id === data.sessionId ? { ...s, label: data.label } : s))
        } else if (data.type === 'agent-event-batch') {
          for (const event of data.events) {
            const simEvent: SimulationEvent = {
              time: event.time,
              type: event.type as SimulationEvent['type'],
              payload: event.payload,
              sessionId: event.sessionId,
            }
            const selected = selectedSessionIdRef.current
            if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
              pendingEventsRef.current.push(simEvent)
            }
            if (event.sessionId) {
              const buf = sessionEventsRef.current.get(event.sessionId) || []
              buf.push(simEvent)
              sessionEventsRef.current.set(event.sessionId, buf)
            }
          }
          setEventVersion(v => v + 1)
        }
      } catch (err) {
        console.error('Error processing SSE message:', err)
      }
    }
    es.onerror = () => {
      setConnectionStatus('disconnected')
    }

    return () => {
      es.close()
    }
  }, [])

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

      // Deliver to pending if session matches (ref is always current).
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      const selected = selectedSessionIdRef.current
      if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
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
        // Auto-select: prefer active sessions, then most recently active.
        // Only set selection — useLayoutEffect handles flushing events.
        if (!selectedSessionIdRef.current && sessionList.length > 0) {
          const sorted = [...sessionList].sort((a, b) => {
            const aActive = a.status === 'active' ? 1 : 0
            const bActive = b.status === 'active' ? 1 : 0
            if (aActive !== bActive) return bActive - aActive
            return b.lastActivityTime - a.lastActivityTime
          })
          const autoId = sorted[0].id
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
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
        // Auto-select newly started session.
        // Set switch-pending flag to prevent the animation frame from processing
        // events in the wrong simulation state before useLayoutEffect swaps it.
        sessionSwitchPendingRef.current = true
        pendingEventsRef.current.length = 0
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

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    const buffered = sessionEventsRef.current.get(sessionId) || []
    pendingEventsRef.current.length = 0
    pendingEventsRef.current.push(...buffered.slice(fromIndex))
    setEventVersion(v => v + 1)
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
    flushSessionEvents,
    getSessionEventCount,
    sessionsWithActivity,
    removeSession,
  }
}
