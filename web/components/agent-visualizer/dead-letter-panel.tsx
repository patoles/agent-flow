'use client'

import { useMemo } from 'react'
import { COLORS } from '@/lib/colors'
import { Z, type ToolCallNode } from '@/lib/agent-types'
import { formatTokens } from '@/lib/utils'
import { PanelHeader, SlidingPanel } from './shared-ui'

interface DeadLetterPanelProps {
  visible: boolean
  toolCalls: Map<string, ToolCallNode>
  onClose: () => void
  onSelectToolCall?: (id: string) => void
}

interface DeadLetter {
  call: ToolCallNode
  /** tokens spent on later calls of the same tool+args by the same agent, i.e. what the failure cost to retry */
  retryCost: number
  retries: number
}

/** Failed tool calls, shunted off the main graph into a siding, with what each failure cost in retries. */
export function DeadLetterPanel({ visible, toolCalls, onClose, onSelectToolCall }: DeadLetterPanelProps) {
  const letters = useMemo<DeadLetter[]>(() => {
    const all = Array.from(toolCalls.values())
    return all
      .filter(tc => tc.state === 'error')
      .map(call => {
        const later = all.filter(o => o.id !== call.id && o.agentId === call.agentId && o.toolName === call.toolName && o.args === call.args && o.startTime > call.startTime)
        return { call, retries: later.length, retryCost: later.reduce((s, o) => s + (o.tokenCost ?? 0), 0) }
      })
      .sort((a, b) => b.call.startTime - a.call.startTime)
  }, [toolCalls])

  if (!visible) return null
  const totalRetryCost = letters.reduce((s, l) => s + l.retryCost, 0)

  return (
    <SlidingPanel visible={visible} position={{ top: 48, right: 12 }} zIndex={Z.sidePanel} width={300}>
      <div className="glass-card relative">
        <PanelHeader onClose={onClose}>
          <span className="text-[10px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            DEAD LETTERS
          </span>
          <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>
            {letters.length} failed · {formatTokens(totalRetryCost)} spent retrying
          </span>
        </PanelHeader>

        <div className="space-y-1 max-h-[340px] overflow-y-auto">
          {letters.length === 0 && (
            <div className="text-[9px] font-mono py-2 text-center" style={{ color: COLORS.textMuted }}>
              No failed tool calls
            </div>
          )}
          {letters.map(({ call, retries, retryCost }) => (
            <div
              key={call.id}
              className="rounded px-2 py-1.5 hover:brightness-125 cursor-pointer"
              style={{ background: 'rgba(30, 10, 15, 0.5)', border: `1px solid ${COLORS.error}30` }}
              onClick={() => onSelectToolCall?.(call.id)}
              title={call.errorMessage}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-mono truncate" style={{ color: COLORS.error }}>
                  {call.toolName} <span style={{ color: COLORS.textMuted }}>{call.args}</span>
                </span>
                <span className="text-[9px] font-mono flex-shrink-0" style={{ color: COLORS.textMuted }}>{call.agentId}</span>
              </div>
              {call.errorMessage && (
                <div className="text-[9px] font-mono mt-0.5 truncate" style={{ color: COLORS.textMuted, opacity: 0.8 }}>
                  {call.errorMessage.split('\n')[0]}
                </div>
              )}
              <div className="text-[9px] font-mono mt-0.5" style={{ color: retries > 0 ? COLORS.tool : COLORS.textMuted }}>
                {retries > 0 ? `${retries} retr${retries === 1 ? 'y' : 'ies'} · ${formatTokens(retryCost)} tokens` : 'not retried'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SlidingPanel>
  )
}
