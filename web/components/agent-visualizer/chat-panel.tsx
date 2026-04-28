'use client'

import { CARD, Z, type Agent, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

interface ChatPanelProps {
  visible: boolean
  agentName: string
  agentState: AgentState
  agentRuntime?: Agent['runtime']
  conversation: ConversationMessage[]
  onClose: () => void
}

export function AgentChatPanel({
  visible,
  agentName,
  agentState,
  agentRuntime,
  conversation,
  onClose,
}: ChatPanelProps) {
  const { ref: logRef } = useAutoScroll(conversation.length, visible)

  const stateColor = getStateColor(agentState)

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 64, right: 12 }}
      zIndex={Z.chatPanel}
      width={CARD.chat.width}
      {...stopPropagationHandlers}
    >
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', maxHeight: CARD.chat.maxHeight }}>
        <PanelHeader onClose={onClose} className="mb-2 flex-shrink-0">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }}
          />
          <span className="text-[10px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            {agentName.toUpperCase()}
          </span>
          <span className="text-[9px] font-mono capitalize" style={{ color: stateColor + '90' }}>
            {agentState}
          </span>
        </PanelHeader>

        {/* Messages */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto space-y-1.5 mb-2"
          style={{ minHeight: CARD.chat.messagesMinHeight, maxHeight: CARD.chat.messagesMaxHeight }}
        >
          {conversation.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[10px] font-mono" style={{ color: COLORS.textMuted }}>
                No messages yet...
              </p>
            </div>
          ) : (
            conversation.map((msg) => (
              <TranscriptMessage key={msg.id} message={msg} agentRuntime={agentRuntime} />
            ))
          )}
        </div>

      </div>
    </SlidingPanel>
  )
}
