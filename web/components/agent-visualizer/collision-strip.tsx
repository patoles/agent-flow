'use client'

import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import type { FileCollision, SessionInfo } from '@/lib/bridge-types'

interface CollisionStripProps {
  collisions: FileCollision[]
  sessions: SessionInfo[]
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
}

/** Cross-session same-file collisions, shown under the top bar. Click a session chip to jump to it. */
export function CollisionStrip({ collisions, sessions, selectedSessionId, onSelectSession }: CollisionStripProps) {
  const cross = collisions.filter(c => c.sessions.length > 1)
  if (cross.length === 0) return null
  const nameOf = (id: string) => sessions.find(x => x.id === id)?.label ?? id.slice(0, 8)
  return (
    <div className="absolute left-3 right-3 flex flex-wrap gap-2 font-mono text-[10px]" style={{ top: 44, zIndex: Z.info }}>
      {cross.map(c => (
        <div
          key={c.file}
          className="flex items-center gap-2 px-2 py-1 rounded-md"
          style={{
            background: 'rgba(255, 170, 51, 0.10)',
            border: `1px solid ${COLORS.waiting_permission}66`,
            color: COLORS.waiting_permission,
            boxShadow: `0 0 12px rgba(255, 170, 51, 0.15)`,
          }}
          title={c.file}
        >
          <span>⚠ {c.file.split(/[\\/]/).pop()}</span>
          {c.sessions.map(sid => (
            <button
              key={sid}
              onClick={() => onSelectSession(sid)}
              className="px-1.5 py-0.5 rounded"
              style={{
                background: sid === selectedSessionId ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                border: `1px solid ${sid === selectedSessionId ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                color: sid === selectedSessionId ? COLORS.holoBright : COLORS.textMuted,
                maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {c.parties.filter(p => p.sessionId === sid).some(p => p.action === 'write') ? '✎ ' : '👁 '}
              {nameOf(sid)}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
