'use client'

import { useRef, useEffect, useState } from 'react'
import { Z, CARD } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { AssistantBrandLabel } from '@/lib/runtime-brand'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { CloseButton, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

// ─── Full session transcript panel ───────────────────────────────────────────

interface TranscriptPanelProps {
  visible: boolean
  conversation: ConversationMessage[]
  assistantLabel: AssistantBrandLabel
  onClose: () => void
}

export function SessionTranscriptPanel({
  visible,
  conversation,
  assistantLabel,
  onClose,
}: TranscriptPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { ref: logRef, handleScroll, scrollToBottom, isAutoScrolling } = useAutoScroll(conversation.length, visible)

  // Focus search when shown
  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  const filteredConversation = searchQuery.trim()
    ? conversation.filter(msg => {
        const q = searchQuery.toLowerCase()
        return msg.content.toLowerCase().includes(q)
          || (msg.toolName || '').toLowerCase().includes(q)
      })
    : conversation

  return (
    <SlidingPanel
      visible={visible}
      position={{ right: 0, bottom: 0, top: 36 }}
      zIndex={Z.transcriptPanel}
      width={CARD.transcript.width}
      {...stopPropagationHandlers}
    >
      <div
        className="h-full flex flex-col"
        style={{
          background: COLORS.panelBg,
          backdropFilter: 'blur(24px)',
          borderLeft: `1px solid ${COLORS.holoBorder10}`,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: `1px solid ${COLORS.holoBorder08}` }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono tracking-widest font-semibold" style={{ color: COLORS.panelLabel }}>
              TRANSCRIPT
            </span>
            <span className="text-[9px] font-mono" style={{ color: COLORS.panelLabelDim }}>
              {searchQuery ? `${filteredConversation.length}/${conversation.length}` : conversation.length} messages
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery('') }}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded transition-all"
              style={{
                background: showSearch ? COLORS.toggleActive : 'transparent',
                color: showSearch ? COLORS.assistantText : COLORS.textMuted,
              }}
            >
              /
            </button>
            <CloseButton onClick={onClose} className="px-1" />
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div className="px-3 pb-2 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') }
                e.stopPropagation()
              }}
              placeholder="Filter messages..."
              className="w-full px-2 py-1 rounded text-[10px] font-mono outline-none"
              style={{
                background: COLORS.holoBg05,
                border: `1px solid ${COLORS.holoBorder12}`,
                color: COLORS.assistantText,
              }}
            />
          </div>
        )}

        {/* Messages */}
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
          style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
        >
          {filteredConversation.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
                {searchQuery ? 'No matching messages' : 'Waiting for session activity...'}
              </p>
            </div>
          ) : (
            filteredConversation.map((msg) => (
              <TranscriptMessage key={msg.id} message={msg} searchQuery={searchQuery} assistantLabel={assistantLabel} />
            ))
          )}

          {/* Scroll-to-bottom indicator */}
          {!isAutoScrolling.current && filteredConversation.length > 0 && (
            <div className="sticky bottom-0 flex justify-center py-1">
              <button
                onClick={scrollToBottom}
                className="text-[9px] font-mono px-3 py-1 rounded-full transition-all"
                style={{
                  background: COLORS.holoBg10,
                  border: `1px solid ${COLORS.glassBorder}`,
                  color: COLORS.scrollBtnText,
                }}
              >
                ↓ New messages
              </button>
            </div>
          )}
        </div>

      </div>
    </SlidingPanel>
  )
}
