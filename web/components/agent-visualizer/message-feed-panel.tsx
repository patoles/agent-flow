'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Agent, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, ROLE_COLORS, getStateColor } from '@/lib/colors'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useVirtualList } from '@/hooks/use-virtual-list'

interface MessageFeedPanelProps {
  conversations: Map<string, ConversationMessage[]>
  agents: Map<string, Agent>
  onAgentClick: (agentId: string | null) => void
  selectedAgentId: string | null
}

// Only show text messages (assistant, user, thinking) — tool calls visible via agent selection
const TEXT_TYPES = new Set(['assistant', 'user', 'thinking'])

// Truncation limits for compact display
const COLLAPSED_AGENT_NAME_MAX = 12
const TAB_AGENT_NAME_MAX = 14
const PREVIEW_MAX = 50
const MESSAGE_TRUNCATE_MAX = 120

const MESSAGE_GAP = 4

// ─── Main component ─────────────────────────────────────────────────────────

export function MessageFeedPanel({
  conversations,
  agents,
  onAgentClick,
  selectedAgentId,
}: MessageFeedPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const logRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  // Stable key that only changes when agent set membership or names change
  const agentKey = useMemo(() => {
    const parts: string[] = []
    for (const [id, a] of agents) parts.push(`${id}:${a.name}:${a.isMain}`)
    return parts.sort().join('|')
  }, [agents])

  // ── Latest message (cheap — used by collapsed view) ──
  const latestMessage = useMemo(() => {
    const currentAgents = agentsRef.current
    let latest: (ConversationMessage & { agentId: string }) | null = null
    for (const [agentId, msgs] of conversations) {
      if (!currentAgents.has(agentId)) continue
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!TEXT_TYPES.has(msgs[i].type)) continue
        if (!latest || msgs[i].timestamp > latest.timestamp) {
          latest = { ...msgs[i], agentId }
        }
        break
      }
    }
    return latest
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, agentKey])

  // ── Expensive memos — only compute when expanded ──

  const agentsWithMessages = useMemo(() => {
    if (!expanded) return []
    const currentAgents = agentsRef.current
    const ids: string[] = []
    for (const [agentId, msgs] of conversations) {
      if (!currentAgents.has(agentId)) continue
      if (msgs.some(m => TEXT_TYPES.has(m.type))) ids.push(agentId)
    }
    return ids.sort((a, b) => {
      const agA = currentAgents.get(a)
      const agB = currentAgents.get(b)
      if (agA?.isMain) return -1
      if (agB?.isMain) return 1
      return (agA?.name ?? a).localeCompare(agB?.name ?? b)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded ? conversations : null, expanded, agentKey])

  // Incremental message cache
  const messagesCacheRef = useRef<{
    key: string
    counts: Map<string, number>
    result: (ConversationMessage & { agentId: string })[]
  }>({ key: '', counts: new Map(), result: [] })

  const messages = useMemo(() => {
    if (!expanded) return []
    const currentAgents = agentsRef.current
    const cache = messagesCacheRef.current
    const cacheKey = `${activeTab}:${agentKey}`

    if (cache.key !== cacheKey) {
      cache.key = cacheKey
      cache.counts = new Map()
      cache.result = []
    }

    if (activeTab === 'all') {
      let appended = false
      for (const [agentId, msgs] of conversations) {
        if (!currentAgents.has(agentId)) continue
        const prevLen = cache.counts.get(agentId) ?? 0
        if (msgs.length > prevLen) {
          for (let i = prevLen; i < msgs.length; i++) {
            if (TEXT_TYPES.has(msgs[i].type)) cache.result.push({ ...msgs[i], agentId })
          }
          cache.counts.set(agentId, msgs.length)
          appended = true
        }
      }
      if (appended) cache.result.sort((a, b) => a.timestamp - b.timestamp)
      return cache.result
    }

    const msgs = conversations.get(activeTab) ?? []
    const prevLen = cache.counts.get(activeTab) ?? 0
    if (msgs.length > prevLen) {
      for (let i = prevLen; i < msgs.length; i++) {
        if (TEXT_TYPES.has(msgs[i].type)) cache.result.push({ ...msgs[i], agentId: activeTab })
      }
      cache.counts.set(activeTab, msgs.length)
    }
    return cache.result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded ? conversations : null, expanded, activeTab, agentKey])

  // Virtual list with auto-scroll
  const {
    visibleItems, totalHeight, offsetTop,
    handleScroll, measureRef,
  } = useVirtualList(messages, logRef, { gap: MESSAGE_GAP, autoScroll: true })

  // Track unread messages per agent tab
  useEffect(() => {
    const totalCount = Array.from(conversations.values()).reduce((n, msgs) => n + msgs.length, 0)
    if (totalCount > prevCountRef.current && expanded) {
      for (const [agentId, msgs] of conversations) {
        if (agentId !== activeTab && activeTab !== 'all' && msgs.length > 0) {
          setUnread(prev => new Set(prev).add(agentId))
        }
      }
    }
    prevCountRef.current = totalCount
  }, [conversations, expanded, activeTab])

  useEffect(() => {
    if (activeTab !== 'all') {
      setUnread(prev => { const next = new Set(prev); next.delete(activeTab); return next })
    } else {
      setUnread(new Set())
    }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'all' && !conversations.has(activeTab)) setActiveTab('all')
  }, [conversations, activeTab])

  useEffect(() => {
    if (selectedAgentId) {
      const selected = agentsRef.current.get(selectedAgentId)
      if (selected && !selected.isMain) setActiveTab(selectedAgentId)
      else setActiveTab('all')
    } else {
      setActiveTab('all')
    }
  }, [selectedAgentId])

  const panelRef = useRef<HTMLDivElement>(null)
  const collapsePanel = useCallback(() => setExpanded(false), [])
  useClickOutside(panelRef, collapsePanel)

  if (!latestMessage && agentsWithMessages.length === 0) return null

  // ── Collapsed ──
  if (!expanded) {
    if (!latestMessage) return null
    const agent = agents.get(latestMessage.agentId)
    const agentName = agent?.name ?? latestMessage.agentId
    const role = ROLE_COLORS[latestMessage.type] ?? ROLE_COLORS.assistant
    const preview = latestMessage.content.replace(/\n/g, ' ').slice(0, PREVIEW_MAX)

    return (
      <div
        className="absolute cursor-pointer transition-all hover:scale-[1.02]"
        style={{ top: 48, left: 12, zIndex: Z.info, pointerEvents: 'auto' }}
        onClick={() => setExpanded(true)}
      >
        <div className="glass-card px-3 py-2 flex items-center gap-2" style={{ maxWidth: 320 }}>
          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: role.text }} />
          <span className="text-[9px] font-mono font-semibold shrink-0" style={{ color: COLORS.textPrimary }}>
            {agentName.length > COLLAPSED_AGENT_NAME_MAX ? agentName.slice(0, COLLAPSED_AGENT_NAME_MAX) + '..' : agentName}
          </span>
          <span className="text-[9px] font-mono truncate" style={{ color: role.text + 'cc' }}>
            {preview}{latestMessage.content.length > PREVIEW_MAX ? '...' : ''}
          </span>
          <span className="text-[9px] shrink-0" style={{ color: COLORS.textMuted }}>▾</span>
        </div>
      </div>
    )
  }

  // ── Expanded (virtualized) ──
  return (
    <div
      ref={panelRef}
      className="absolute"
      style={{ top: 48, left: 12, zIndex: Z.info, pointerEvents: 'auto' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="glass-card flex flex-col" style={{ width: 320, maxHeight: 420 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-[10px] font-mono font-semibold tracking-wider" style={{ color: COLORS.textPrimary }}>
            MESSAGES
          </span>
          <button
            onClick={() => setExpanded(false)}
            className="text-[9px] transition-colors"
            style={{ color: COLORS.textMuted }}
          >
            ▴
          </button>
        </div>

        {/* Agent Tabs (hidden when only 1 agent) */}
        {agentsWithMessages.length > 1 && (
        <div className="flex gap-0.5 px-2 pb-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <TabButton
            label="All"
            active={activeTab === 'all'}
            onClick={() => setActiveTab('all')}
            color={COLORS.holoBase}
          />
          {agentsWithMessages.map(agentId => {
            const agent = agents.get(agentId)
            const name = agent?.name ?? agentId
            const color = agent ? getStateColor(agent.state) : COLORS.idle
            return (
              <TabButton
                key={agentId}
                label={name.length > TAB_AGENT_NAME_MAX ? name.slice(0, TAB_AGENT_NAME_MAX) + '..' : name}
                active={activeTab === agentId}
                onClick={() => setActiveTab(agentId)}
                color={color}
                hasUnread={unread.has(agentId)}
              />
            )
          })}
        </div>
        )}

        {/* Message List (virtualized) */}
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-2 pb-2"
          style={{ maxHeight: 340, scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
        >
          {messages.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>
                No messages yet
              </span>
            </div>
          ) : (
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div style={{ position: 'absolute', top: offsetTop, left: 0, right: 0 }}>
                {visibleItems.map((msg) => (
                  <div
                    key={msg.id}
                    ref={(el) => measureRef(msg.id, el)}
                    style={{ marginBottom: MESSAGE_GAP }}
                  >
                    <MessageRow
                      message={msg}
                      agentId={msg.agentId}
                      agentName={agents.get(msg.agentId)?.name ?? msg.agentId}
                      showAgent={activeTab === 'all'}
                      isSelected={selectedAgentId === msg.agentId}
                      onClick={() => { onAgentClick(msg.agentId); setExpanded(false) }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Tab Button ──

function TabButton({ label, active, onClick, color, hasUnread }: {
  label: string
  active: boolean
  onClick: () => void
  color: string
  hasUnread?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded text-[9px] font-mono transition-all shrink-0 relative"
      style={{
        background: active ? color + '20' : 'transparent',
        color: active ? color : COLORS.textMuted,
        border: active ? `1px solid ${color}30` : '1px solid transparent',
      }}
    >
      {label}
      {hasUnread && (
        <span
          className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
          style={{ background: COLORS.unreadDot }}
        />
      )}
    </button>
  )
}

// ── Message Row ──

function MessageRow({ message, agentId, agentName, showAgent, isSelected, onClick }: {
  message: ConversationMessage
  agentId: string
  agentName: string
  showAgent: boolean
  isSelected: boolean
  onClick: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const role = ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant
  const isLong = message.content.length > MESSAGE_TRUNCATE_MAX
  const displayText = expanded || !isLong ? message.content : message.content.slice(0, MESSAGE_TRUNCATE_MAX) + '...'

  return (
    <div
      className="rounded px-2 py-1.5 cursor-pointer transition-all"
      style={{
        background: isSelected ? role.bgSelected : role.bg,
        borderLeft: isSelected ? `2px solid ${role.text}` : '2px solid transparent',
      }}
      onClick={onClick}
    >
      {/* Header row */}
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[9px] font-mono font-semibold" style={{ color: role.text + '90' }}>
          {role.label}
        </span>
        {showAgent && (
          <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>
            {agentName}
          </span>
        )}
      </div>

      {/* Content */}
      <div
        className="text-[9px] font-mono leading-relaxed whitespace-pre-wrap break-words"
        style={{ color: role.text }}
      >
        {displayText}
      </div>

      {/* Expand/collapse for long messages */}
      {isLong && (
        <button
          className="text-[9px] font-mono mt-0.5 transition-colors"
          style={{ color: COLORS.textMuted }}
          onClick={(e) => { e.stopPropagation(); setExpanded(prev => !prev) }}
        >
          {expanded ? '▴ less' : '▾ more'}
        </button>
      )}
    </div>
  )
}
