/**
 * Transcript parsing logic extracted from SessionWatcher.
 *
 * Parses JSONL transcript lines and emits AgentEvents via a delegate,
 * keeping the parsing logic decoupled from file-watching concerns.
 */

import {
  AgentEvent, PendingToolCall, WatchedSession,
  TranscriptEntry, ToolUseBlock, ToolResultBlock,
  emitSubagentSpawn,
} from './protocol'
import { readFileChunk } from './fs-utils'
import {
  PREVIEW_MAX, ARGS_MAX, RESULT_MAX, MESSAGE_MAX,
  SESSION_LABEL_MAX, SESSION_LABEL_TRUNCATED,
  CHILD_NAME_MAX,
  HASH_PREFIX_MAX,
  ORCHESTRATOR_NAME,
  FAILED_RESULT_MAX,
  SYSTEM_CONTENT_PREFIXES,
  generateSubagentFallbackName,
  resolveSubagentChildName,
} from './constants'
import { summarizeInput, summarizeResult, extractInputData, detectError, buildDiscovery } from './tool-summarizer'
import { estimateTokensFromContent, estimateTokensFromText } from './token-estimator'
import { createLogger } from './logger'

const log = createLogger('TranscriptParser')

export interface TranscriptParserDelegate {
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
  getSession(sessionId: string): WatchedSession | undefined
  fireSessionLifecycle(event: { type: 'started' | 'ended' | 'updated'; sessionId: string; label: string }): void
  emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string): void
}

/** Type guard: check if a value is a non-null object */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Safely extract trimmed text from a text block */
function safeText(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.text || '').trim()
}

/** Safely extract trimmed thinking content from a thinking block */
function safeThinking(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.thinking || '').trim()
}

/** Returns the signature string if a thinking block is redacted
 *  (plaintext stripped but signature present, as Opus 4.7+ does), else null. */
function redactedThinkingSignature(block: unknown): string | null {
  if (!isRecord(block)) return null
  if (String(block.thinking || '').trim()) return null
  const sig = block.signature
  return typeof sig === 'string' && sig.length > 0 ? sig : null
}

/** Build the dedup hash key for a thinking block. Prefers the transcript entry
 *  UUID; falls back to a prefix of the content (or signature, for redacted blocks). */
function thinkingHashKey(entryUuid: string | undefined, fallbackSource: string): string {
  return entryUuid
    ? `thinking:${entryUuid}`
    : `thinking:${fallbackSource.slice(0, HASH_PREFIX_MAX)}`
}

/** Placeholder shown for redacted thinking blocks (matches Claude Code's UI label). */
const REDACTED_THINKING_LABEL = 'Thinking...'

export class TranscriptParser {
  /** Per-subagent dedup state for inline progress events, keyed by parentToolUseID */
  private inlineSubagentState = new Map<string, {
    agentName: string
    pending: Map<string, PendingToolCall>
    seen: Set<string>
    seenMessages: Set<string>
  }>()
  /** Maps Agent tool_use ID → resolved child agent name (set in handleToolUse) */
  private subagentChildNames = new Map<string, string>()

  constructor(private delegate: TranscriptParserDelegate) {}

  /** Clean up state associated with a completed session to prevent unbounded Map growth.
   *  Pass the session's pending tool_use_ids so we can remove orphaned entries. */
  clearSessionState(pendingToolUseIds: Iterable<string>): void {
    for (const toolUseId of pendingToolUseIds) {
      this.inlineSubagentState.delete(toolUseId)
      this.subagentChildNames.delete(toolUseId)
    }
  }

  processTranscriptLine(
    line: string,
    agentName = ORCHESTRATOR_NAME,
    ctxPending: Map<string, PendingToolCall>,
    ctxSeen: Set<string>,
    sessionId?: string,
    ctxSeenMessages?: Set<string>,
  ): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line.trim()) as Record<string, unknown>
    } catch (err) {
      log.debug('Skipping unparseable line:', err)
      return
    }

    // Handle inline subagent progress events (newer Claude Code versions)
    if (parsed.type === 'progress') {
      this.handleProgressEvent(parsed, sessionId)
      return
    }

    // Only process actual conversation entries (user/assistant turns)
    if (parsed.type !== 'user' && parsed.type !== 'assistant') {
      return
    }

    const msg = parsed.message as TranscriptEntry['message'] | undefined
    if (!msg) { return }

    // Now we know this is a valid transcript entry
    const entry: TranscriptEntry = {
      sessionId: parsed.sessionId as string,
      type: parsed.type as string,
      uuid: parsed.uuid as string | undefined,
      message: msg,
    }

    // Try to set session label from first user message (for live events after session start)
    if (sessionId) {
      this.maybeSetSessionLabel(entry, sessionId)
    }

    const role = msg.role // 'assistant', 'user', 'human'

    const session = sessionId ? this.delegate.getSession(sessionId) : undefined

    // Extract model from assistant messages (updates tokensMax on the frontend)
    if (session && !session.model && entry.type === 'assistant' && msg.model) {
      session.model = msg.model
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'model_detected',
        payload: { agent: agentName, model: msg.model },
      }, sessionId)
    }

    // Dedup set for messages (context compression replays old messages)
    const seenMsgs = ctxSeenMessages ?? session?.seenMessageHashes

    // Handle string content (user messages are often just strings)
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (role === 'user' || role === 'human') {
        const text = msg.content.trim()
        // Skip system-injected context (continuation summaries, IDE context, etc.)
        if (!this.isSystemInjectedContent(text)) {
          const hash = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
          if (seenMsgs && seenMsgs.has(hash)) { /* skip duplicate */ }
          else {
            seenMsgs?.add(hash)
            if (session) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
            this.delegate.emit({
              time: this.delegate.elapsed(sessionId),
              type: 'message',
              payload: { agent: agentName, role: 'user', content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
      return
    }

    if (!Array.isArray(msg.content)) { return }

    // Determine the emitted role from the JSONL entry role
    const emitRole = (role === 'user' || role === 'human') ? 'user' : 'assistant'

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseBlock
        if (ctxSeen.has(toolBlock.id)) { continue }
        ctxSeen.add(toolBlock.id)
        this.handleToolUse(toolBlock, agentName, ctxPending, sessionId)
      } else if (block.type === 'tool_result') {
        this.handleToolResult(block as ToolResultBlock, agentName, ctxPending, sessionId)
      } else if (block.type === 'text' && 'text' in block) {
        this.handleTextBlock(block, emitRole, entry.uuid, agentName, seenMsgs, session, sessionId)
      } else if (block.type === 'thinking' && 'thinking' in block) {
        this.handleThinkingBlock(block, entry.uuid, agentName, seenMsgs, session, sessionId)
      }
    }

    if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
  }

  /** Process a text block — dedup, track tokens, emit message event */
  private handleTextBlock(
    block: unknown,
    emitRole: 'user' | 'assistant',
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const text = safeText(block)
    if (!text) return
    // Skip system/IDE context injected into user turns
    if (emitRole === 'user' && this.isSystemInjectedContent(text)) return

    const hash = entryUuid ? `${emitRole}:${entryUuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    if (session) {
      if (emitRole === 'user') { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
      else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
    }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: { agent: agentName, role: emitRole, content: text.slice(0, MESSAGE_MAX) },
    }, sessionId)
  }

  /** Process a thinking block — dedup, track tokens, emit message event.
   *  Redacted thinking (Opus 4.7+) is shown as a "Thinking..." placeholder. */
  private handleThinkingBlock(
    block: unknown,
    entryUuid: string | undefined,
    agentName: string,
    seenMsgs: Set<string> | undefined,
    session: WatchedSession | undefined,
    sessionId?: string,
  ): void {
    const thinking = safeThinking(block)
    const redactedSig = thinking ? null : redactedThinkingSignature(block)
    if (!thinking && !redactedSig) return

    const hash = thinkingHashKey(entryUuid, thinking || redactedSig || '')
    if (seenMsgs?.has(hash)) return
    seenMsgs?.add(hash)

    // Reasoning tokens are unknown for redacted blocks — skip breakdown update
    if (session && thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: {
        agent: agentName,
        role: 'thinking',
        content: thinking ? thinking.slice(0, MESSAGE_MAX) : REDACTED_THINKING_LABEL,
      },
    }, sessionId)
  }

  handleToolUse(
    block: ToolUseBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
  ): void {
    const toolName = block.name
    const args = summarizeInput(toolName, block.input)

    const rawPath = block.input.file_path || block.input.path
    const filePath = typeof rawPath === 'string' ? rawPath : undefined
    ctxPending.set(block.id, {
      name: toolName,
      args,
      filePath,
      startTime: Date.now(),
    })

    // Check if this is a subagent call (Task in older Claude Code, Agent in newer versions)
    if (toolName === 'Task' || toolName === 'Agent') {
      const childName = resolveSubagentChildName(block.input)
      this.subagentChildNames.set(block.id, childName)
      // Only emit spawn once per subagent name (file watcher may have already spawned it)
      const session = sessionId ? this.delegate.getSession(sessionId) : undefined
      if (!session?.spawnedSubagents.has(childName)) {
        session?.spawnedSubagents.add(childName)
        emitSubagentSpawn(this.delegate, agentName, childName, args, sessionId)
      }
    }

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(toolName, block.input),
      },
    }, sessionId)
  }

  handleToolResult(
    block: ToolResultBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    sessionId?: string,
  ): void {
    const pending = ctxPending.get(block.tool_use_id)
    // Skip orphaned tool_results (their tool_use was deduped during catch-up)
    if (!pending) { return }
    const toolName = pending.name
    const result = summarizeResult(block.content)
    const tokenCost = estimateTokensFromContent(block.content)

    // Update context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) {
        if (toolName === 'Task' || toolName === 'Agent') {
          session.contextBreakdown.subagentResults += tokenCost
        } else {
          session.contextBreakdown.toolResults += tokenCost
        }
      }
    }

    ctxPending.delete(block.tool_use_id)

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, pending?.filePath || '', result)

    // If it was a subagent call completing, emit subagent return
    if (toolName === 'Task' || toolName === 'Agent') {
      const childName = this.subagentChildNames.get(block.tool_use_id) || pending?.args?.slice(0, CHILD_NAME_MAX) || 'subagent'
      // Clean up inline subagent tracking state
      this.subagentChildNames.delete(block.tool_use_id)
      this.inlineSubagentState.delete(block.tool_use_id)
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'subagent_return',
        payload: { child: childName, parent: agentName, summary: result.slice(0, ARGS_MAX) },
      }, sessionId)
      this.delegate.emit({
        time: this.delegate.elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: childName },
      }, sessionId)
    }

    // Detect errors in tool output
    const isError = detectError(result)
    const errorMessage = isError ? result.slice(0, FAILED_RESULT_MAX) : undefined

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, RESULT_MAX),
        tokenCost,
        ...(discovery ? { discovery } : {}),
        ...(isError ? { isError, errorMessage } : {}),
      },
    }, sessionId)

    // Emit updated context breakdown
    if (sessionId) {
      const session = this.delegate.getSession(sessionId)
      if (session) { this.delegate.emitContextUpdate(agentName, session, sessionId) }
    }
  }

  /**
   * Handle inline progress events from newer Claude Code versions.
   * These carry subagent transcript entries directly in the main JSONL,
   * keyed by parentToolUseID (the Agent tool_use that spawned the subagent).
   */
  private handleProgressEvent(
    parsed: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const data = parsed.data
    if (!isRecord(data) || data.type !== 'agent_progress') { return }

    const innerEntry = data.message as TranscriptEntry | undefined
    if (!innerEntry?.message) { return }

    const parentToolUseID = typeof parsed.parentToolUseID === 'string' ? parsed.parentToolUseID : undefined
    if (!parentToolUseID) { return }

    // Get or create per-subagent dedup state
    let subState = this.inlineSubagentState.get(parentToolUseID)
    if (!subState) {
      // Resolve agent name from the stored child name (set when the Agent tool_use was parsed)
      const childName = this.subagentChildNames.get(parentToolUseID) || generateSubagentFallbackName('', this.inlineSubagentState.size + 1)
      subState = {
        agentName: childName,
        pending: new Map(),
        seen: new Set(),
        seenMessages: new Set(),
      }
      this.inlineSubagentState.set(parentToolUseID, subState)

      // Mark this subagent as receiving inline progress — file watcher should skip events
      if (sessionId) {
        const session = this.delegate.getSession(sessionId)
        session?.inlineProgressAgents.add(childName)
      }
    }

    // Re-wrap as a JSONL line and process through the normal pipeline
    const innerLine = JSON.stringify(innerEntry)
    this.processTranscriptLine(innerLine, subState.agentName, subState.pending, subState.seen, sessionId, subState.seenMessages)
  }

  /**
   * Pre-scan existing file content:
   * 1. Build seenToolUseIds dedup set (prevents re-emitting old tool calls)
   * 2. Return all entries for catch-up emission
   */
  prescanExistingContent(filePath: string, size: number, session: WatchedSession): TranscriptEntry[] {
    if (size === 0) { return [] }
    const catchUpEntries: TranscriptEntry[] = []
    try {
      // Read only up to `size` bytes — the file may have grown since stat.
      // Reading beyond would add tool_use IDs to the dedup set that haven't
      // been accounted for in fileSize, causing readNewLines to silently skip them.
      const content = readFileChunk(filePath, 0, size)
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) { continue }
        try {
          const entry = JSON.parse(line.trim()) as TranscriptEntry
          // Build dedup sets for tool_use blocks and messages + accumulate token counts
          const isUser = entry.message?.role === 'user' || entry.message?.role === 'human'
          if (entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && (block as ToolUseBlock).id) {
                const toolBlock = block as ToolUseBlock
                session.seenToolUseIds.add(toolBlock.id)
                // Track subagent names so startWatchingSubagentFile assigns correct names
                // and handleToolResult can resolve the child name on completion
                if (toolBlock.name === 'Agent' || toolBlock.name === 'Task') {
                  const childName = resolveSubagentChildName(toolBlock.input)
                  session.spawnedSubagents.add(childName)
                  this.subagentChildNames.set(toolBlock.id, childName)
                }
                // Track pending tool calls so handleToolResult works after reconnect
                const args = summarizeInput(toolBlock.name, toolBlock.input)
                const rawPath = toolBlock.input.file_path || toolBlock.input.path
                const filePath = typeof rawPath === 'string' ? rawPath : undefined
                session.pendingToolCalls.set(toolBlock.id, { name: toolBlock.name, args, filePath, startTime: Date.now() })
              } else if (block.type === 'tool_result') {
                const resultBlock = block as ToolResultBlock
                // Clear matched pending tool call
                if (resultBlock.tool_use_id) {
                  session.pendingToolCalls.delete(resultBlock.tool_use_id)
                }
                // Accumulate tool result tokens
                session.contextBreakdown.toolResults += estimateTokensFromContent(resultBlock.content)
              } else if (block.type === 'text' && 'text' in block) {
                const text = safeText(block)
                if (text) {
                  const emitRole = isUser ? 'user' : 'assistant'
                  const hashKey = entry.uuid ? `${emitRole}:${entry.uuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
                  session.seenMessageHashes.add(hashKey)
                  // Accumulate text tokens
                  if (isUser) { session.contextBreakdown.userMessages += estimateTokensFromText(text) }
                  else { session.contextBreakdown.reasoning += estimateTokensFromText(text) }
                }
              } else if (block.type === 'thinking' && 'thinking' in block) {
                const thinking = safeThinking(block)
                const redactedSig = thinking ? null : redactedThinkingSignature(block)
                if (thinking || redactedSig) {
                  session.seenMessageHashes.add(thinkingHashKey(entry.uuid, thinking || redactedSig || ''))
                  if (thinking) { session.contextBreakdown.reasoning += estimateTokensFromText(thinking) }
                }
              }
            }
          } else if (entry.type === 'user' && typeof entry.message?.content === 'string') {
            const text = entry.message.content.trim()
            if (text) {
              const hashKey = entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
              session.seenMessageHashes.add(hashKey)
              session.contextBreakdown.userMessages += estimateTokensFromText(text)
            }
          }
          // Extract model from first assistant message
          if (entry.type === 'assistant' && entry.message?.model && !session.model) {
            session.model = entry.message.model
          }
          // Collect emittable entries (user and assistant turns)
          if (entry.type === 'user' || entry.type === 'assistant') {
            catchUpEntries.push(entry)
          }
        } catch (err) { log.debug('Skipping unparseable transcript line:', err) }
      }
      log.info(`Pre-scanned ${session.seenToolUseIds.size} existing tool_use IDs, ${catchUpEntries.length} entries total`)

      return catchUpEntries
    } catch (err) {
      log.error('Pre-scan failed:', err)
      return []
    }
  }

  /** Emit message events for pre-existing transcript entries (catch-up on session detection).
   *  Only emits the last user message (the current turn), not the full history. */
  emitCatchUpEntries(entries: TranscriptEntry[], session: WatchedSession, sessionId: string): void {
    // Find the last user entry — that's the current turn
    let lastUserIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'user') { lastUserIndex = i; break }
    }
    if (lastUserIndex === -1) { return }
    const recentEntries = entries.slice(lastUserIndex)

    for (const entry of recentEntries) {
      const role = entry.type === 'user' ? 'user' : 'assistant'
      const msg = entry.message
      if (!msg) { continue }

      // String content (common for user messages)
      if (typeof msg.content === 'string' && msg.content.trim()) {
        const text = msg.content.trim()
        if (this.isSystemInjectedContent(text)) { continue }
        this.delegate.emit({
          time: 0,
          type: 'message',
          payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
        }, sessionId)
        continue
      }

      // Array content (text blocks, thinking blocks, tool_use blocks)
      if (!Array.isArray(msg.content)) { continue }
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) {
            this.delegate.emit({
              time: 0,
              type: 'message',
              payload: { agent: ORCHESTRATOR_NAME, role, content: text.slice(0, MESSAGE_MAX) },
            }, sessionId)
          }
        }
      }
    }
  }

  /** Extract a human-readable label from the first user message in transcript entries */
  extractSessionLabel(entries: TranscriptEntry[], session: WatchedSession): void {
    if (session.labelSet) return
    for (const entry of entries) {
      if (entry.type !== 'user') continue
      const text = this.extractUserMessageText(entry)
      if (text) {
        session.label = this.truncateLabel(text)
        session.labelSet = true
        return
      }
    }
  }

  /** Extract text content from a user transcript entry, skipping system-injected tags */
  extractUserMessageText(entry: TranscriptEntry): string | null {
    const msg = entry.message
    if (!msg) return null
    if (typeof msg.content === 'string' && msg.content.trim()) {
      const text = msg.content.trim()
      if (!this.isSystemInjectedContent(text)) return text
      return null
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && 'text' in block) {
          const text = safeText(block)
          if (text && !this.isSystemInjectedContent(text)) return text
        }
      }
    }
    return null
  }

  /** Check if text is system-injected context (not a real user/assistant message) */
  isSystemInjectedContent(text: string): boolean {
    return SYSTEM_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))
  }

  /** Truncate to first line, max chars — fits in a tab */
  truncateLabel(text: string): string {
    const firstLine = text.split('\n')[0].trim()
    if (firstLine.length <= SESSION_LABEL_MAX) return firstLine
    return firstLine.slice(0, SESSION_LABEL_TRUNCATED) + '..'
  }

  /** Update session label on first user message and notify the webview */
  maybeSetSessionLabel(entry: TranscriptEntry, sessionId: string): void {
    const session = this.delegate.getSession(sessionId)
    if (!session || session.labelSet) return
    if (entry.type !== 'user') return
    const text = this.extractUserMessageText(entry)
    if (!text) return
    session.label = this.truncateLabel(text)
    session.labelSet = true
    this.delegate.fireSessionLifecycle({ type: 'updated', sessionId, label: session.label })
  }
}
