'use client'

import { useMemo } from 'react'
import { COLORS, getStateColor } from '@/lib/colors'
import { Z, type Agent, type ToolCallNode, type FileAttention } from '@/lib/agent-types'
import type { FileCollision, SessionInfo } from '@/lib/bridge-types'
import { folderName } from '@/lib/session-label'
import { formatTokens, formatModelName, getModelColor } from '@/lib/utils'
import { agentCost } from './canvas/draw-cost'

interface StatusSidebarProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  fileAttention: Map<string, FileAttention>
  collisions: FileCollision[]
  onSelectSession: (id: string) => void
  onOpenDeadLetters: () => void
  onOpenFiles: () => void
  /** Hide while a side panel (Files / Chat / Dead letters) occupies the right edge */
  hidden: boolean
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass-card p-3 flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider" style={{ color: COLORS.textMuted }}>{title}</div>
      {children}
    </section>
  )
}

function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: COLORS.textMuted }}>{label}</span>
      <span className="truncate" style={{ color: color ?? COLORS.holoBright }}>{value}</span>
    </div>
  )
}

/** Right-hand sidebar: live facts about the selected session (agents, tools, files, cost) plus same-file collisions across sessions. */
export function StatusSidebar({
  sessions, selectedSessionId, agents, toolCalls, fileAttention, collisions,
  onSelectSession, onOpenDeadLetters, onOpenFiles, hidden,
}: StatusSidebarProps) {
  const session = sessions.find(s => s.id === selectedSessionId)

  const stats = useMemo(() => {
    let running = 0, failed = 0, done = 0
    for (const tc of toolCalls.values()) {
      if (tc.state === 'running') running++
      else if (tc.state === 'error') failed++
      else done++
    }
    const agentList = Array.from(agents.values()).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || b.tokensUsed - a.tokensUsed)
    const tokens = agentList.reduce((s, a) => s + a.tokensUsed, 0)
    const files = Array.from(fileAttention.values()).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5)
    return { running, failed, done, agentList, tokens, files }
  }, [agents, toolCalls, fileAttention])

  if (hidden || !session) return null

  const nameOf = (id: string) => {
    const s = sessions.find(x => x.id === id)
    if (!s) return id.slice(0, 8)
    return s.cwd ? `${folderName(s.cwd)} · ${s.label}` : s.label
  }

  return (
    <div
      className="absolute flex flex-col gap-3 font-mono text-[12px] overflow-y-auto"
      style={{ top: 52, right: 12, bottom: 96, width: 300, zIndex: Z.info }}
    >
      <Section title="Session">
        <div className="truncate" style={{ color: COLORS.holoBright }} title={session.cwd}>{session.cwd ? folderName(session.cwd) : session.label}</div>
        <Row label="status" value={session.status === 'active' ? 'active' : 'idle'} color={session.status === 'active' ? COLORS.complete : COLORS.textMuted} />
        <Row label="started" value={ago(session.startTime)} />
        <Row label="last activity" value={ago(session.lastActivityTime)} />
        <Row label="tokens" value={`${formatTokens(stats.tokens)} · ~$${agentCost(stats.tokens).toFixed(2)}`} />
      </Section>

      <Section title={`Agents · ${stats.agentList.length}`}>
        {stats.agentList.map(a => (
          <div key={a.id} className="flex flex-col gap-0.5 rounded px-2 py-1.5" style={{ background: 'rgba(10, 15, 30, 0.5)', border: `1px solid ${getStateColor(a.state)}30` }}>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: getStateColor(a.state), boxShadow: `0 0 6px ${getStateColor(a.state)}` }} />
              <span className="truncate" style={{ color: COLORS.holoBright, paddingLeft: (a.depth ?? 0) * 8 }}>{a.name}</span>
            </div>
            <div className="flex items-center justify-between gap-2" style={{ color: COLORS.textMuted, fontSize: 11 }}>
              <span style={{ color: getModelColor(a.model) ?? COLORS.textMuted }}>{a.model ? formatModelName(a.model) : '—'}</span>
              <span>{a.state.replace('_', ' ')} · {formatTokens(a.tokensUsed)}{a.tokensMax ? `/${formatTokens(a.tokensMax)}` : ''}</span>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Tool calls">
        <Row label="running" value={stats.running} color={stats.running > 0 ? COLORS.tool : undefined} />
        <Row label="completed" value={stats.done} />
        <div className="flex items-center justify-between gap-3 cursor-pointer" onClick={onOpenDeadLetters} title="Open dead letters">
          <span style={{ color: COLORS.textMuted }}>failed</span>
          <span style={{ color: stats.failed > 0 ? COLORS.error : COLORS.holoBright }}>{stats.failed}{stats.failed > 0 ? ' ›' : ''}</span>
        </div>
      </Section>

      {stats.files.length > 0 && (
        <Section title="Hot files">
          {stats.files.map(f => (
            <div key={f.path} className="flex items-center justify-between gap-2 cursor-pointer" onClick={onOpenFiles} title={f.path}>
              <span className="truncate" style={{ color: COLORS.holoBright }}>{f.path.split(/[\\/]/).pop()}</span>
              <span className="flex-shrink-0" style={{ color: COLORS.textMuted, fontSize: 11 }}>
                {f.reads > 0 ? `${f.reads}r ` : ''}{f.edits > 0 ? `${f.edits}w ` : ''}{formatTokens(f.totalTokens)}
              </span>
            </div>
          ))}
        </Section>
      )}

      {collisions.length > 0 && (
        <Section title="Same file, same time">
          {collisions.map(c => (
            <div key={c.file} className="flex flex-col gap-1 rounded px-2 py-1.5" style={{ background: 'rgba(30, 20, 5, 0.5)', border: `1px solid ${COLORS.waiting_permission}40` }} title={c.file}>
              <div className="truncate" style={{ color: COLORS.waiting_permission }}>⚠ {c.file.split(/[\\/]/).pop()}</div>
              <div className="truncate" style={{ color: COLORS.textMuted, fontSize: 10 }}>{c.file}</div>
              {c.sessions.map(sid => {
                const parties = c.parties.filter(p => p.sessionId === sid)
                const wrote = parties.some(p => p.action === 'write')
                const agentNames = [...new Set(parties.map(p => p.agent))]
                return (
                  <div key={sid} className="flex flex-col gap-0.5">
                    <button
                      onClick={() => onSelectSession(sid)}
                      className="px-2 py-1 rounded text-left truncate"
                      style={{
                        background: sid === selectedSessionId ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                        border: `1px solid ${sid === selectedSessionId ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                        color: sid === selectedSessionId ? COLORS.holoBright : COLORS.textMuted,
                      }}
                      title={nameOf(sid)}
                    >
                      {wrote ? '✎ ' : '👁 '}{nameOf(sid)}
                    </button>
                    {agentNames.length > 1 && <div style={{ color: COLORS.textMuted, fontSize: 10 }}>{agentNames.join(' ↔ ')}</div>}
                  </div>
                )
              })}
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}
