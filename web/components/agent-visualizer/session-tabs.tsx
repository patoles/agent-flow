'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  /** Prefix tab labels with the session's folder name (standalone app, or multiple workspaces) */
  showFolder: boolean
}

const RENAME_STORAGE_KEY = 'agent-flow-session-names'

function loadCustomNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(RENAME_STORAGE_KEY) || '{}') } catch { return {} }
}

function folderName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
  showFolder,
}: SessionTabsProps) {
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [customNames, setCustomNames] = useState<Record<string, string>>(loadCustomNames)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commitRename = useCallback((id: string, name: string) => {
    setCustomNames(prev => {
      const next = { ...prev }
      if (name.trim()) next[id] = name.trim()
      else delete next[id] // empty name = reset to default label
      try { localStorage.setItem(RENAME_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    setEditingId(null)
  }, [])

  const displayLabel = useCallback((session: SessionInfo) => {
    const custom = customNames[session.id]
    if (custom) return custom
    return showFolder && session.cwd ? `${folderName(session.cwd)} · ${session.label}` : session.label
  }, [customNames, showFolder])

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
      {sessions.map(session => {
        const isSelected = session.id === selectedSessionId
        const isActive = session.status === 'active'
        const hasActivity = sessionsWithActivity.has(session.id)
        // Green dot: session is active, OR has unseen background activity
        const showGreen = isActive || hasActivity
        return (
          <button
            key={session.id}
            ref={(el) => setButtonRef(session.id, el)}
            onClick={() => onSelectSession(session.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setDraft(customNames[session.id] ?? '')
              setEditingId(session.id)
            }}
            title="Right-click to rename"
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
            {editingId === session.id ? (
              <input
                autoFocus
                value={draft}
                placeholder={displayLabel(session)}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(session.id, draft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(session.id, draft)
                  else if (e.key === 'Escape') setEditingId(null)
                }}
                className="bg-transparent outline-none font-mono text-[10px]"
                style={{ color: COLORS.holoBright, width: Math.max(8, (draft || displayLabel(session)).length) + 'ch' }}
              />
            ) : displayLabel(session)}
            <span
              className="ml-0.5 opacity-0 group-hover:opacity-60 transition-opacity cursor-pointer"
              style={{ color: COLORS.tabClose, fontSize: 8, lineHeight: '10px' }}
              onClick={(e) => {
                e.stopPropagation()
                onCloseSession(session.id)
              }}
            >
              ✕
            </span>
          </button>
        )
      })}
    </div>
  )
}
