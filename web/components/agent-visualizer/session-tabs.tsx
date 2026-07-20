'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'

interface SessionTabProps {
  session: SessionInfo
  isSelected: boolean
  hasActivity: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Ref callback so parents can scroll the selected tab into view. */
  buttonRef?: (el: HTMLButtonElement | null) => void
}

/** A single session tab button. Shared by the flat list and the grouped nav. */
export function SessionTab({ session, isSelected, hasActivity, onSelect, onClose, buttonRef }: SessionTabProps) {
  const isActive = session.status === 'active'
  // Green dot: session is active, OR has unseen background activity
  const showGreen = isActive || hasActivity
  return (
    <button
      ref={buttonRef}
      onClick={() => onSelect(session.id)}
      className="group px-1.5 py-0.5 rounded transition-all flex items-center gap-1"
      style={{
        flexShrink: 0,
        whiteSpace: 'nowrap',
        background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
        border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
        color: isSelected ? COLORS.holoBright : COLORS.textMuted,
      }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{
          background: showGreen ? COLORS.complete : COLORS.idle + '40',
          boxShadow: showGreen ? `0 0 4px ${COLORS.complete}` : 'none',
          animation: hasActivity && !isSelected ? 'pulse 1.5s infinite' : 'none',
        }}
      />
      {session.label}
      <span
        className="ml-0.5 opacity-0 group-hover:opacity-60 transition-opacity cursor-pointer"
        style={{ color: COLORS.tabClose, fontSize: 8, lineHeight: '10px' }}
        onClick={(e) => {
          e.stopPropagation()
          onClose(session.id)
        }}
      >
        ✕
      </span>
    </button>
  )
}

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

/** Flat list of session tabs. Used as a fallback when grouping adds no value
 *  (a single project). See {@link SessionNav} for the grouped/filtered view. */
export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
}: SessionTabsProps) {
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const setButtonRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(id, el)
    else buttonRefs.current.delete(id)
  }, [])

  // Scroll selected tab into view whenever it changes
  useEffect(() => {
    if (!selectedSessionId) return
    const el = buttonRefs.current.get(selectedSessionId)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  return (
    <div className="flex gap-1">
      {sessions.map(session => (
        <SessionTab
          key={session.id}
          session={session}
          isSelected={session.id === selectedSessionId}
          hasActivity={sessionsWithActivity.has(session.id)}
          onSelect={onSelectSession}
          onClose={onCloseSession}
          buttonRef={(el) => setButtonRef(session.id, el)}
        />
      ))}
    </div>
  )
}
