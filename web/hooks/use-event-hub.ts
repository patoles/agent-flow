'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { eventHubClient, type HubSessionInfo } from '@/lib/event-hub-client'
import type { SimulationEvent } from '@/lib/agent-types'
import type { SessionInfo, ConnectionStatus } from '@/lib/vscode-bridge'

/**
 * React hook that connects to the agent-viz event hub via WebSocket.
 * Returns the same shape as useVSCodeBridge so useAgentSimulation works unchanged.
 */
export function useEventHub() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())

  useEffect(() => {
    const client = eventHubClient
    if (!client) return

    client.connect()

    const unsubStatus = client.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubEvent = client.onEvent((event: SimulationEvent) => {
      // Buffer by session
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(event)
        sessionEventsRef.current.set(event.sessionId, buf)
      }

      // Deliver to pending if session matches
      const selected = selectedSessionIdRef.current
      if (event.type === 'agent_spawn') {
        console.log('[use-event-hub] agent_spawn for', event.sessionId?.slice(0,8), 'selected:', selected?.slice(0,8), 'match:', event.sessionId === selected)
      }
      if (selected && event.sessionId === selected) {
        pendingEventsRef.current.push(event)
        setEventVersion(v => v + 1)
      } else if (!selected) {
        // No session selected yet — buffer but also push to pending
        pendingEventsRef.current.push(event)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && event.sessionId !== selected) {
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }
    })

    const unsubSession = client.onSession((type, data) => {
      if (type === 'list') {
        const listData = data as { sessions: HubSessionInfo[]; selectedSessionId?: string }
        const hubSessions = Array.isArray(data) ? data as HubSessionInfo[] : listData.sessions
        const preSelected = !Array.isArray(data) ? listData.selectedSessionId : undefined
        const mapped: SessionInfo[] = hubSessions.map(s => ({
          id: s.id,
          label: s.label,
          status: s.status as 'active' | 'completed',
          startTime: s.startTime,
          lastActivityTime: s.lastActivityTime,
        }))
        setSessions(mapped)
        // Use hub's pre-selected session (it already sent event-batch for it)
        if (!selectedSessionIdRef.current && mapped.length > 0) {
          const autoId = preSelected || mapped[0].id
          console.log('[use-event-hub] auto-selecting session:', autoId.slice(0, 8))
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
        }
      } else if (type === 'started') {
        const session = data as HubSessionInfo
        const mapped: SessionInfo = {
          id: session.id,
          label: session.label,
          status: session.status as 'active' | 'completed',
          startTime: session.startTime,
          lastActivityTime: session.lastActivityTime,
        }
        setSessions(prev => {
          if (prev.find(s => s.id === session.id)) return prev
          return [...prev, mapped]
        })
        // Auto-select only if no session is currently selected
        if (!selectedSessionIdRef.current) {
          selectedSessionIdRef.current = session.id
          setSelectedSessionId(session.id)
        }
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
      unsubStatus()
      unsubEvent()
      unsubSession()
      client.dispose()
    }
  }, [])

  const consumeEvents = useCallback(() => {
    pendingEventsRef.current.length = 0
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      eventHubClient?.selectSession(sessionId)
    }
  }, [])

  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    const buffered = sessionEventsRef.current.get(sessionId) || []
    pendingEventsRef.current.length = 0
    pendingEventsRef.current.push(...buffered.slice(fromIndex))
    setEventVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId))
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const bridgeOpenFile = useCallback((_filePath: string, _line?: number) => {
    // No-op in standalone mode — could open in browser or copy to clipboard
  }, [])

  return {
    isVSCode: false,
    connectionStatus,
    pendingEvents: pendingEventsRef.current as readonly SimulationEvent[],
    consumeEvents,
    useMockData: false, // Never show mock data — we always use hub events
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
