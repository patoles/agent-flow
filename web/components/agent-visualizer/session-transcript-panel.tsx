'use client'

import { useRef, useEffect, useState } from 'react'
import { Z, CARD } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { CloseButton, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useVirtualList } from '@/hooks/use-virtual-list'

// ─── Constants ──────────────────────────────────────────────────────────────

const TRANSCRIPT_GAP = 8 // matches mb-2
const TRANSCRIPT_INITIAL_VIEWPORT = 400

// ─── Component ──────────────────────────────────────────────────────────────

interface TranscriptPanelProps {
  visible: boolean
  conversation: ConversationMessage[]
  onClose: () => void
}

export function SessionTranscriptPanel({
  visible,
  conversation,
  onClose,
}: TranscriptPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  const filteredConversation = visible
    ? (searchQuery.trim()
        ? conversation.filter(msg => {
            const q = searchQuery.toLowerCase()
            return msg.content.toLowerCase().includes(q)
              || (msg.toolName || '').toLowerCase().includes(q)
          })
        : conversation)
    : []

  const {
    visibleItems, totalHeight, offsetTop,
    handleScroll, measureRef: itemMeasureRef,
    isAtBottom, scrollToBottom,
  } = useVirtualList(filteredConversation, scrollRef, {
    gap: TRANSCRIPT_GAP,
    initialViewportHeight: TRANSCRIPT_INITIAL_VIEWPORT,
    autoScroll: true,
  })

  if (!visible) return null

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

        {/* Virtualized message list */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-3 py-2"
          style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
        >
          {filteredConversation.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
                {searchQuery ? 'No matching messages' : 'Waiting for session activity...'}
              </p>
            </div>
          ) : (
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div style={{ position: 'absolute', top: offsetTop, left: 0, right: 0 }}>
                {visibleItems.map((msg) => (
                  <div
                    key={msg.id}
                    ref={(el) => itemMeasureRef(msg.id, el)}
                    style={{ marginBottom: TRANSCRIPT_GAP }}
                  >
                    <TranscriptMessage message={msg} searchQuery={searchQuery} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scroll-to-bottom button */}
        {!isAtBottom && filteredConversation.length > 0 && (
          <div className="flex justify-center py-1 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
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
    </SlidingPanel>
  )
}
