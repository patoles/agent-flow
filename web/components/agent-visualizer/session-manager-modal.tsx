'use client'

import { useEffect, useMemo, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { folderName, sessionDisplayLabel } from '@/lib/session-label'
import { GlassCard } from './glass-card'
import { PanelHeader, stopPropagationHandlers } from './shared-ui'

interface SessionManagerModalProps {
  visible: boolean
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  showFolder: boolean
  customNames: Record<string, string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  onClose: () => void
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function SessionManagerModal({
  visible, sessions, selectedSessionId, sessionsWithActivity, showFolder, customNames,
  onSelectSession, onCloseSession, onRenameSession, onClose,
}: SessionManagerModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Escape while renaming only cancels the edit; a second Escape closes the modal
      setEditingId(current => {
        if (current === null) onClose()
        return null
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  // Active first, then most recent
  const sorted = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return [...sessions]
      .filter(s => !q || sessionDisplayLabel(s, customNames[s.id], true).toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q))
      .sort((a, b) => {
        const act = (b.status === 'active' ? 1 : 0) - (a.status === 'active' ? 1 : 0)
        return act || b.lastActivityTime - a.lastActivityTime
      })
  }, [sessions, filter, customNames])

  const commit = (id: string) => { onRenameSession(id, draft); setEditingId(null) }

  if (!visible) return null

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ zIndex: Z.contextMenu, background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div {...stopPropagationHandlers} onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 90vw)' }}>
        <GlassCard visible={visible} className="p-3 font-mono text-[11px]" style={{ maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
          <PanelHeader onClose={onClose}>
            <span style={{ color: COLORS.holoBright }}>Sessions</span>
            <span style={{ color: COLORS.textMuted }}>{sessions.length}</span>
          </PanelHeader>
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or path…"
            className="w-full mb-2 px-2 py-1 rounded bg-transparent outline-none"
            style={{ border: `1px solid ${COLORS.holoBorder06}`, color: COLORS.holoBright }}
          />
          <div className="overflow-y-auto" style={{ minHeight: 0 }}>
            {sorted.length === 0 && <div style={{ color: COLORS.textMuted }}>No sessions</div>}
            {sorted.map(session => {
              const isSelected = session.id === selectedSessionId
              const live = session.status === 'active' || sessionsWithActivity.has(session.id)
              const label = sessionDisplayLabel(session, customNames[session.id], showFolder)
              return (
                <div
                  key={session.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
                  style={{
                    background: isSelected ? COLORS.tabSelectedBg : 'transparent',
                    border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : 'transparent'}`,
                  }}
                  onClick={() => { if (editingId !== session.id) { onSelectSession(session.id); onClose() } }}
                  title="Click to open · ✎ to rename"
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: live ? COLORS.complete : COLORS.idle + '40', boxShadow: live ? `0 0 4px ${COLORS.complete}` : 'none' }}
                  />
                  <div className="min-w-0 flex-1">
                    {editingId === session.id ? (
                      <input
                        autoFocus
                        value={draft}
                        placeholder={label}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commit(session.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(session.id)
                          else if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null) }
                        }}
                        className="w-full bg-transparent outline-none"
                        style={{ color: COLORS.holoBright }}
                      />
                    ) : (
                      <div className="truncate" style={{ color: isSelected ? COLORS.holoBright : COLORS.textMuted }}>
                        {label}
                        {customNames[session.id] && <span style={{ color: COLORS.textMuted, marginLeft: 6 }}>({session.label})</span>}
                      </div>
                    )}
                    <div className="truncate" style={{ color: COLORS.textMuted, opacity: 0.6, fontSize: 9 }}>
                      {session.cwd ? `${folderName(session.cwd)} · ${session.cwd}` : session.id.slice(0, 8)}
                    </div>
                  </div>
                  <span className="flex-shrink-0" style={{ color: COLORS.textMuted, fontSize: 9 }}>
                    {session.status === 'active' ? 'active' : 'done'} · {ago(session.lastActivityTime)}
                  </span>
                  <button
                    className="flex-shrink-0 px-1 opacity-50 hover:opacity-100"
                    style={{ color: COLORS.textMuted }}
                    title="Rename"
                    onClick={(e) => { e.stopPropagation(); setDraft(customNames[session.id] ?? ''); setEditingId(session.id) }}
                  >
                    ✎
                  </button>
                  <button
                    className="flex-shrink-0 px-1 opacity-50 hover:opacity-100"
                    style={{ color: COLORS.tabClose }}
                    title="Dismiss"
                    onClick={(e) => { e.stopPropagation(); onCloseSession(session.id) }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        </GlassCard>
      </div>
    </div>
  )
}
