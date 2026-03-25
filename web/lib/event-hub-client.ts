/**
 * WebSocket client singleton for connecting to the agent-viz event hub.
 * Mirrors the structure of vscode-bridge.ts for consistent API.
 */

import type { SimulationEvent } from './agent-types'

export interface HubSessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
}

type EventCallback = (event: SimulationEvent) => void
type StatusCallback = (status: 'connected' | 'disconnected' | 'watching') => void
type SessionCallback = (
  type: 'list' | 'started' | 'ended' | 'updated' | 'reset',
  data: unknown
) => void

class EventHubClient {
  private ws: WebSocket | null = null
  private eventListeners: EventCallback[] = []
  private statusListeners: StatusCallback[] = []
  private sessionListeners: SessionCallback[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 10000
  private url: string

  constructor(url = 'ws://localhost:7850/ws') {
    this.url = url
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return
    }

    this.notifyStatus('watching')

    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[event-hub] Connected to', this.url)
      this.reconnectDelay = 1000
      this.notifyStatus('connected')
    }

    this.ws.onmessage = (ev) => {
      try {
        const raw = ev.data as string
        console.log('[event-hub] raw msg type:', raw.slice(0, 50))
        const msg = JSON.parse(raw)
        this.handleMessage(msg)
      } catch (err) {
        console.error('[event-hub] message parse error:', err, 'data length:', (ev.data as string)?.length)
      }
    }

    this.ws.onclose = () => {
      console.log('[event-hub] Disconnected')
      this.notifyStatus('disconnected')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire after this
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'event': {
        const event = msg.event as SimulationEvent
        console.log('[event-hub] event:', event?.type, event?.sessionId?.slice(0, 8))
        if (event) this.eventListeners.forEach(cb => cb(event))
        break
      }
      case 'event-batch': {
        const events = msg.events as SimulationEvent[]
        console.log('[event-hub] event-batch:', events?.length, 'events')
        if (Array.isArray(events)) {
          events.forEach(event => this.eventListeners.forEach(cb => cb(event)))
        }
        break
      }
      case 'session-list': {
        const sessions = msg.sessions as HubSessionInfo[]
        const preSelected = msg.selectedSessionId as string | undefined
        console.log('[event-hub] session-list:', sessions?.length, 'sessions, preSelected:', preSelected?.slice(0, 8))
        this.sessionListeners.forEach(cb => cb('list', { sessions, selectedSessionId: preSelected }))
        break
      }
      case 'session-started': {
        this.sessionListeners.forEach(cb => cb('started', msg.session))
        break
      }
      case 'session-ended': {
        this.sessionListeners.forEach(cb => cb('ended', msg.sessionId))
        break
      }
      case 'session-updated': {
        this.sessionListeners.forEach(cb => cb('updated', {
          sessionId: msg.sessionId,
          label: msg.label,
        }))
        break
      }
      case 'connection-status': {
        // Hub confirms connection
        break
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay)
      this.connect()
    }, this.reconnectDelay)
  }

  private notifyStatus(status: 'connected' | 'disconnected' | 'watching') {
    this.statusListeners.forEach(cb => cb(status))
  }

  onEvent(cb: EventCallback): () => void {
    this.eventListeners.push(cb)
    return () => { this.eventListeners = this.eventListeners.filter(l => l !== cb) }
  }

  onStatus(cb: StatusCallback): () => void {
    this.statusListeners.push(cb)
    return () => { this.statusListeners = this.statusListeners.filter(l => l !== cb) }
  }

  onSession(cb: SessionCallback): () => void {
    this.sessionListeners.push(cb)
    return () => { this.sessionListeners = this.sessionListeners.filter(l => l !== cb) }
  }

  selectSession(sessionId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'select-session', sessionId }))
    }
  }

  dispose() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) this.ws.close()
    this.eventListeners = []
    this.statusListeners = []
    this.sessionListeners = []
  }
}

/** Create a new client instance. Call connect() to start. */
export function createEventHubClient(url?: string) {
  if (typeof window === 'undefined') return null
  return new EventHubClient(url)
}

/** @deprecated Use createEventHubClient() instead */
export const eventHubClient = createEventHubClient()
