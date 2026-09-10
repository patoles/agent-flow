'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { folderName } from '@/lib/session-label'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  /** Prefix tab labels with the session's folder name (standalone app, or multiple workspaces) */
  showFolder: boolean
  customNames: Record<string, string>
  onRenameSession: (id: string, name: string) => void
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
  showFolder,
  customNames,
  onRenameSession,
}: SessionTabsProps) {
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commitRename = useCallback((id: string, name: string) => {
    onRenameSession(id, name)
    setEditingId(null)
  }, [onRenameSession])

  /** Text part of the tab (folder is rendered as its own chip) */
  const displayLabel = useCallback(
    (session: SessionInfo) => customNames[session.id] || session.label,
    [customNames],
  )

  // Most recently active first; the selected tab keeps its slot among peers
  const ordered = [...sessions].sort((a, b) => b.lastActivityTime - a.lastActivityTime)

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
    <div className="flex gap-1.5">
      {ordered.map(session => {
        const isSelected = session.id === selectedSessionId
        const isActive = session.status === 'active'
        const hasActivity = sessionsWithActivity.has(session.id)
        // Green dot: session is active, OR has unseen background activity
        const showGreen = isActive || hasActivity
        const folder = showFolder && session.cwd ? folderName(session.cwd) : null
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
            title={`${session.cwd ?? ''}\n${session.label}\nRight-click to rename`}
            className="group px-2.5 py-1 rounded-md transition-all flex items-center gap-2 font-mono text-[11px]"
            style={{
              flexShrink: 0,
              maxWidth: 260,
              whiteSpace: 'nowrap',
              background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
              border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
              boxShadow: isSelected ? `0 0 14px ${COLORS.tabSelectedBg}, inset 0 0 12px ${COLORS.tabInactiveBg}` : 'none',
              color: isSelected ? COLORS.holoBright : COLORS.textMuted,
              opacity: !isSelected && !isActive ? 0.7 : 1,
            }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full flex-shrink-0"
              style={{
                background: showGreen ? COLORS.complete : COLORS.idle + '40',
                boxShadow: showGreen ? `0 0 6px ${COLORS.complete}` : 'none',
                animation: hasActivity && !isSelected ? 'pulse 1.5s infinite' : 'none',
              }}
            />
            {folder && editingId !== session.id && (
              <span
                className="flex-shrink-0 px-1 rounded text-[9px] uppercase tracking-wider"
                style={{
                  background: isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder,
                  color: isSelected ? COLORS.holoBright : COLORS.textMuted,
                  maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {folder}
              </span>
            )}
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
                className="bg-transparent outline-none font-mono text-[11px]"
                style={{ color: COLORS.holoBright, width: Math.max(8, (draft || displayLabel(session)).length) + 'ch' }}
              />
            ) : (
              <span className="truncate" style={{ minWidth: 0 }}>{displayLabel(session)}</span>
            )}
            <span
              className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity cursor-pointer"
              style={{ color: COLORS.tabClose, fontSize: 10, lineHeight: '12px' }}
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
