'use client'

import { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { COLORS } from '@/lib/colors'
import { useClickOutside } from '@/hooks/use-click-outside'
import { groupSessions } from '@/lib/session-grouping'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { SessionTab } from './session-tabs'

/** Active grouping filter. `null` = show everything. `worktree: null` = whole project. */
export type SessionFilter = { project: string; worktree: string | null } | null

interface SessionNavProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  filter: SessionFilter
  onFilterChange: (filter: SessionFilter) => void
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

function matchesFilter(filter: SessionFilter, project: string, worktree: string | null): boolean {
  if (!filter) return true
  if (filter.project !== project) return false
  if (filter.worktree === null) return true
  return filter.worktree === worktree
}

function filterLabel(filter: SessionFilter): string {
  if (!filter) return 'All sessions'
  return filter.worktree ? `${filter.project} › ${filter.worktree}` : filter.project
}

/**
 * Grouped, filterable session navigator. Sessions are bucketed by project then
 * worktree (derived from each session's cwd). Users can:
 *   - focus one project/worktree via the filter dropdown, and
 *   - collapse individual project groups in the rail.
 * Falls back to a flat rail when there's only one project (no grouping value).
 */
export function SessionNav({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  filter,
  onFilterChange,
  onSelectSession,
  onCloseSession,
}: SessionNavProps) {
  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const closeDropdown = useCallback(() => setDropdownOpen(false), [])
  useClickOutside(dropdownRef, closeDropdown)

  // Scroll the selected tab into view on change.
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  const toggleCollapse = useCallback((project: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
  }, [])

  const hasGrouping = groups.length > 1 || (groups[0] && groups[0].worktrees.length > 1)

  // Fallback: a single ungrouped bucket — render a plain rail, no headers/filter.
  if (!hasGrouping) {
    return (
      <div className="flex gap-1 items-center">
        {sessions.map(session => (
          <SessionTab
            key={session.id}
            session={session}
            isSelected={session.id === selectedSessionId}
            hasActivity={sessionsWithActivity.has(session.id)}
            onSelect={onSelectSession}
            onClose={onCloseSession}
            buttonRef={session.id === selectedSessionId ? (el) => { selectedRef.current = el } : undefined}
          />
        ))}
      </div>
    )
  }

  const visibleGroups = groups.filter(g => filter ? g.project === filter.project : true)

  return (
    <div className="flex gap-2 items-center">
      {/* Filter dropdown */}
      <div ref={dropdownRef} className="relative flex-shrink-0">
        <button
          onClick={() => setDropdownOpen(o => !o)}
          className="px-1.5 py-0.5 rounded transition-all flex items-center gap-1"
          style={{
            background: filter ? COLORS.toggleActive : COLORS.toggleInactive,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: filter ? COLORS.holoBright : COLORS.textMuted,
            whiteSpace: 'nowrap',
          }}
          title="Filter sessions by project / worktree"
        >
          <span style={{ opacity: 0.7 }}>⌗</span>
          {filterLabel(filter)}
          <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
        </button>

        {dropdownOpen && (
          <div
            className="absolute left-0 mt-1 rounded py-1 max-h-[60vh] overflow-y-auto scrollbar-hide"
            style={{
              minWidth: 160,
              background: 'rgba(10, 20, 40, 0.96)',
              border: `1px solid ${COLORS.holoBorder12}`,
              backdropFilter: 'blur(8px)',
              zIndex: 50,
            }}
          >
            <DropdownItem
              label="All sessions"
              active={!filter}
              onClick={() => { onFilterChange(null); closeDropdown() }}
            />
            {groups.map(g => (
              <div key={g.project}>
                <DropdownItem
                  label={`${g.project} (${g.count})`}
                  active={!!filter && filter.project === g.project && filter.worktree === null}
                  onClick={() => { onFilterChange({ project: g.project, worktree: null }); closeDropdown() }}
                />
                {g.worktrees.filter(w => w.worktree !== null).map(w => (
                  <DropdownItem
                    key={w.worktree}
                    label={w.worktree!}
                    indent
                    active={!!filter && filter.project === g.project && filter.worktree === w.worktree}
                    onClick={() => { onFilterChange({ project: g.project, worktree: w.worktree }); closeDropdown() }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Grouped rail */}
      {visibleGroups.map(group => {
        const isCollapsed = collapsed.has(group.project)
        return (
          <div key={group.project} className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => toggleCollapse(group.project)}
              className="flex items-center gap-1 transition-opacity hover:opacity-100"
              style={{ color: COLORS.holoBright, opacity: 0.85, whiteSpace: 'nowrap' }}
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              <span style={{ fontSize: 8, opacity: 0.7 }}>{isCollapsed ? '▸' : '▾'}</span>
              <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>{group.project}</span>
              {isCollapsed && (
                <span style={{ color: COLORS.textMuted }}>({group.count})</span>
              )}
            </button>

            {!isCollapsed && group.worktrees
              .filter(w => matchesFilter(filter, group.project, w.worktree))
              .map(w => (
                <div key={w.worktree ?? '∅'} className="flex items-center gap-1">
                  {w.worktree && (
                    <span
                      style={{ color: COLORS.textMuted, opacity: 0.8, whiteSpace: 'nowrap' }}
                      title="worktree"
                    >
                      {w.worktree}
                    </span>
                  )}
                  {w.sessions.map(session => (
                    <SessionTab
                      key={session.id}
                      session={session}
                      isSelected={session.id === selectedSessionId}
                      hasActivity={sessionsWithActivity.has(session.id)}
                      onSelect={onSelectSession}
                      onClose={onCloseSession}
                      buttonRef={session.id === selectedSessionId ? (el) => { selectedRef.current = el } : undefined}
                    />
                  ))}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

function DropdownItem({ label, active, indent, onClick }: {
  label: string
  active: boolean
  indent?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="block w-full text-left px-2 py-1 transition-colors hover:bg-[rgba(100,200,255,0.08)]"
      style={{
        paddingLeft: indent ? 22 : 8,
        color: active ? COLORS.holoBright : COLORS.textMuted,
        background: active ? COLORS.toggleActive : 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {indent && <span style={{ opacity: 0.5, marginRight: 4 }}>›</span>}
      {label}
    </button>
  )
}
