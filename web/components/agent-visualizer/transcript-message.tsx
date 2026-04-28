'use client'

import { useState } from 'react'
import type { Agent } from '@/lib/agent-types'
import { getMessageSenderLabel } from '@/lib/agent-runtime'
import { COLORS } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import type { ConversationMessage } from '@/hooks/simulation/types'

// ─── Shared message rendering utilities ──────────────────────────────────────

export function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} style={{ background: COLORS.searchHighlightBg, color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{part}</mark>
          : part
      )}
    </>
  )
}

export function TranscriptMessage({
  message,
  compact = false,
  searchQuery,
  agentRuntime,
}: {
  message: ConversationMessage
  compact?: boolean
  searchQuery?: string
  agentRuntime?: Agent['runtime']
}) {
  const [expanded, setExpanded] = useState(false)
  const runtime = message.runtime ?? agentRuntime

  switch (message.type) {
    case 'user':
      return (
        <div
          className="rounded px-2.5 py-2 text-[10px] font-mono leading-relaxed"
          style={{
            background: COLORS.userMsgBg,
            border: `1px solid ${COLORS.userMsgBorder}`,
          }}
        >
          <div className="text-[9px] mb-1 font-semibold tracking-wider" style={{ color: COLORS.userLabel }}>
            {getMessageSenderLabel(message.type, runtime)}
          </div>
          <div style={{ color: COLORS.userText }} className="whitespace-pre-wrap break-words">
            <HighlightText text={message.content} query={searchQuery} />
          </div>
        </div>
      )

    case 'assistant':
      return (
        <div
          className="rounded px-2.5 py-2 text-[10px] font-mono leading-relaxed"
          style={{
            background: COLORS.panelSeparator,
            border: `1px solid ${COLORS.holoBorder08}`,
          }}
        >
          <div className="text-[9px] mb-1 font-semibold tracking-wider" style={{ color: COLORS.assistantLabel }}>
            {getMessageSenderLabel(message.type, runtime)}
          </div>
          <div style={{ color: COLORS.assistantText }} className="whitespace-pre-wrap break-words">
            <HighlightText text={compact ? message.content.slice(0, 200) + (message.content.length > 200 ? '...' : '') : message.content} query={searchQuery} />
          </div>
        </div>
      )

    case 'thinking':
      return (
        <div
          className="rounded px-2.5 py-1.5 cursor-pointer transition-all"
          style={{
            background: expanded ? COLORS.thinkingBgExpanded : COLORS.thinkingBgCollapsed,
            border: `1px solid ${COLORS.thinkingBorder}`,
          }}
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold tracking-wider" style={{ color: COLORS.thinkingLabel }}>
              {getMessageSenderLabel(message.type, runtime)}
            </span>
            <span className="text-[9px]" style={{ color: COLORS.thinkingArrow }}>{expanded ? '▾' : '▸'}</span>
            {!expanded && (
              <span className="text-[9px] font-mono truncate opacity-50" style={{ color: COLORS.thinkingPreview }}>
                {message.content.slice(0, 60)}...
              </span>
            )}
          </div>
          {expanded && (
            <div
              className="mt-1.5 text-[9px] font-mono leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: COLORS.thinkingTextExpanded, borderLeft: `2px solid ${COLORS.thinkingBorderLeft}`, paddingLeft: 8 }}
            >
              {compact ? message.content.slice(0, 500) : message.content}
            </div>
          )}
        </div>
      )

    case 'tool_call':
      return (
        <div
          className="rounded px-2.5 py-1.5"
          style={{
            background: COLORS.toolCallBg,
            border: `1px solid ${COLORS.toolCallBorder}`,
          }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[9px]" style={{ color: COLORS.userLabel }}>⚙</span>
            <span className="text-[9px] font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
              {message.toolName || 'Tool'}
            </span>
          </div>
          {message.inputData ? (
            <ToolContentRenderer
              toolName={message.toolName || ''}
              inputData={message.inputData}
              args={message.content}
              compact={compact}
            />
          ) : (
            <div className="text-[9px] font-mono opacity-60" style={{ color: COLORS.assistantText }}>
              {message.content}
            </div>
          )}
        </div>
      )

    case 'tool_result': {
      const resultText = message.content.replace(/^< /, '')
      const isBash = message.toolName === 'Bash'
      return (
        <div
          className="rounded px-2.5 py-1 text-[9px] font-mono"
          style={{
            background: isBash ? COLORS.bashResultBg : COLORS.toolResultBg,
            border: `1px solid ${isBash ? COLORS.bashResultBorder : COLORS.toolResultBorder}`,
            color: isBash ? COLORS.bashResultText : COLORS.toolResultText,
          }}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9px] opacity-50">{isBash ? '$' : '✓'}</span>
            {message.toolName && (
              <span className="text-[9px] opacity-60">{message.toolName}</span>
            )}
          </div>
          <div className={isBash ? 'whitespace-pre-wrap leading-relaxed' : ''}>
            <HighlightText text={resultText.slice(0, compact ? 80 : 400)} query={searchQuery} />
          </div>
        </div>
      )
    }

    default:
      return (
        <div className="rounded px-2.5 py-1.5 text-[10px] font-mono" style={{ color: COLORS.textFaint }}>
          {message.content}
        </div>
      )
  }
}
