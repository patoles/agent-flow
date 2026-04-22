/**
 * Parser for Codex rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex writes five top-level record types. This parser handles all of them:
 *
 *   session_meta  — first line; carries cwd, cli_version, session id, base
 *                   instructions (system prompt)
 *   turn_context  — per turn; carries the authoritative model id for that turn
 *                   plus approval/sandbox policy. May change mid-session.
 *   response_item — OpenAI Responses API-shaped turn data: messages, function
 *                   calls, function call outputs, custom tool calls, reasoning
 *   event_msg     — Codex lifecycle events: task_started/complete, token_count,
 *                   agent_reasoning (plaintext thinking), exec_command_end, etc.
 *   compacted     — auto-compaction marker with replacement_history
 *
 * Dedup strategy:
 *   Messages     — emitted from response_item.message only. event_msg's
 *                   agent_message / user_message are mirrors of the response_item
 *                   content (sometimes imperfect for user messages) and are
 *                   skipped. System-injected user content (IDE context,
 *                   subagent notifications) is filtered.
 *   Reasoning    — emitted from event_msg.agent_reasoning only. response_item's
 *                   reasoning payload carries encrypted_content + summary[] and
 *                   isn't useful for display.
 *   Tool results — emitted from function_call_output / custom_tool_call_output
 *                   only. event_msg.exec_command_end / patch_apply_end are
 *                   parallel signals and are skipped.
 *
 * Subagents: Codex does not currently expose subagent spawning in rollouts.
 * The parser emits a single orchestrator; if Codex adds spawn_agent / wait_agent
 * in future, add mapping here.
 */

import { AgentEvent } from './protocol'
import {
  ORCHESTRATOR_NAME, HASH_PREFIX_MAX, MESSAGE_MAX, PREVIEW_MAX, RESULT_MAX,
  SYSTEM_PROMPT_BASE_TOKENS, SYSTEM_CONTENT_PREFIXES,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery, detectError,
} from './tool-summarizer'
import { estimateTokenCost, estimateTokensFromText } from './token-estimator'
import { createLogger } from './logger'

const log = createLogger('CodexRolloutParser')

// ─── State ─────────────────────────────────────────────────────────────────

export interface CodexContextBreakdown {
  systemPrompt: number
  userMessages: number
  toolResults: number
  reasoning: number
  subagentResults: number
}

export interface PendingCodexToolCall {
  name: string
  args: string
  startTime: number
  filePath?: string
}

export interface CodexRolloutState {
  /** Model id from the most recent turn_context. Authoritative. */
  model: string | null
  /** Cwd from session_meta, updated by turn_context. */
  cwd: string | null
  /** Label for the session (set from first non-system user message). */
  label: string | null
  /** Pending tool calls, keyed by call_id. */
  pendingToolCalls: Map<string, PendingCodexToolCall>
  /** Content hashes of already-emitted messages (for dedup across replays). */
  seenMessageHashes: Set<string>
  /** Running token breakdown. */
  contextBreakdown: CodexContextBreakdown
  /** Orchestrator agent_spawn emitted flag. */
  spawnEmitted: boolean
  /** Last emitted model id, so we only emit model_detected when it changes. */
  lastEmittedModel: string | null
  /** Authoritative total tokens from the last event_msg.token_count, if any. */
  lastReportedTokens: number | null
  /** Authoritative model_context_window from event_msg.token_count, if any. */
  reportedContextWindow: number | null
}

export function createCodexRolloutState(): CodexRolloutState {
  return {
    model: null,
    cwd: null,
    label: null,
    pendingToolCalls: new Map(),
    seenMessageHashes: new Set(),
    contextBreakdown: {
      systemPrompt: SYSTEM_PROMPT_BASE_TOKENS,
      userMessages: 0,
      toolResults: 0,
      reasoning: 0,
      subagentResults: 0,
    },
    spawnEmitted: false,
    lastEmittedModel: null,
    lastReportedTokens: null,
    reportedContextWindow: null,
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface CodexParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when a session label is derived from the first user message. */
  setLabel?(label: string): void
}

// ─── Record shapes (structural typing, all fields optional) ────────────────

interface RolloutRecord {
  type?: string
  payload?: unknown
}

interface MessageContent {
  type?: string
  text?: string
}

interface MessagePayload {
  role?: string
  content?: MessageContent[] | string
}

interface FunctionCallPayload {
  name?: string
  arguments?: string
  call_id?: string
}

interface FunctionCallOutputPayload {
  call_id?: string
  output?: string | { output?: string; metadata?: unknown }
}

interface CustomToolCallPayload {
  name?: string
  input?: string
  call_id?: string
}

interface CustomToolCallOutputPayload {
  call_id?: string
  output?: string | { output?: string; metadata?: unknown }
}

interface WebSearchCallPayload {
  status?: string
  action?: { type?: string; query?: string }
}

interface SessionMetaPayload {
  id?: string
  cwd?: string
  cli_version?: string
  base_instructions?: { text?: string }
}

interface TurnContextPayload {
  model?: string
  cwd?: string
  personality?: string
}

interface CompactedPayload {
  message?: string
  replacement_history?: Array<{ type?: string; role?: string; content?: MessageContent[] | string }>
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Flatten message content into a single trimmed string. */
function flattenContent(content: MessageContent[] | string | undefined): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(c => String(c?.text || '')).join('').trim()
}

/** Markers identifying Codex-injected user messages that contain no real user prompt. */
const CODEX_PURE_INJECTION_PREFIXES = [
  '# AGENTS.md instructions for', // project-level instructions
  '<environment_context>',         // per-turn environment metadata
  '<turn_aborted>',                // interruption marker
  '<subagent_notification>',       // reserved for future subagent support
]

/** Marker the Codex IDE wrapper places before the actual user prompt. */
const CODEX_REQUEST_MARKER = '## My request for Codex:'

/**
 * Extract the real user-authored text from a Codex user message.
 *
 * Codex's IDE wrapper inlines open tabs, active file, diagnostics, etc.
 * before the user's actual request, separated by a "## My request for Codex:"
 * header. For pure injections (AGENTS.md, env context, aborts) we return null
 * so the caller skips the message entirely.
 *
 * Returns null for pure injections, the extracted prompt for wrapped messages,
 * or the original text (trimmed) otherwise.
 */
function extractCodexUserText(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (SYSTEM_CONTENT_PREFIXES.some(p => text.startsWith(p))) return null
  if (CODEX_PURE_INJECTION_PREFIXES.some(p => text.startsWith(p))) return null
  if (text.startsWith('# Context from my IDE setup:')) {
    const idx = text.indexOf(CODEX_REQUEST_MARKER)
    if (idx < 0) return null // IDE context with no request — skip
    return text.slice(idx + CODEX_REQUEST_MARKER.length).trim() || null
  }
  return text
}

/** Parse tool-call arguments — Codex encodes them as a JSON string. */
function parseArgsJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch { return undefined }
}

/** Extract an output string from a function_call_output payload.
 *  Codex sometimes encodes output as a JSON object with nested .output. */
function extractOutputString(raw: FunctionCallOutputPayload['output']): string {
  if (typeof raw === 'string') {
    // May itself be a JSON envelope: try to unwrap .output
    try {
      const parsed = JSON.parse(raw)
      if (isRecord(parsed) && typeof parsed.output === 'string') return parsed.output
    } catch { /* raw string, return as-is */ }
    return raw
  }
  if (isRecord(raw) && typeof raw.output === 'string') return raw.output
  return ''
}

/** Pull the first "*** Update File: /path" line out of an apply_patch body. */
function extractPatchFilePath(patch: string): string | undefined {
  const m = patch.match(/^\*\*\* (?:Update File|Add File|Delete File):\s*(.+)$/m)
  return m ? m[1].trim() : undefined
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class CodexRolloutParser {
  constructor(private delegate: CodexParserDelegate) {}

  /** Parse a single JSONL line. Silently skips unparseable/unknown lines. */
  processLine(line: string, state: CodexRolloutState): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let record: RolloutRecord
    try { record = JSON.parse(trimmed) as RolloutRecord }
    catch { return /* partial line at file tail; resume on next read */ }

    this.ensureSpawned(state)

    switch (record.type) {
      case 'session_meta':
        return this.handleSessionMeta(record.payload as SessionMetaPayload, state)
      case 'turn_context':
        return this.handleTurnContext(record.payload as TurnContextPayload, state)
      case 'response_item':
        return this.handleResponseItem(record.payload, state)
      case 'event_msg':
        return this.handleEventMsg(record.payload, state)
      case 'compacted':
        return this.handleCompacted(record.payload as CompactedPayload, state)
      // Ignore unknown types (forward-compatible).
    }
  }

  // ─── Orchestrator lifecycle ──────────────────────────────────────────────

  private ensureSpawned(state: CodexRolloutState): void {
    if (state.spawnEmitted) return
    state.spawnEmitted = true
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: 'Codex session', runtime: 'codex' },
    })
  }

  // ─── session_meta ────────────────────────────────────────────────────────

  private handleSessionMeta(payload: SessionMetaPayload | undefined, state: CodexRolloutState): void {
    if (!payload) return
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd
    // Estimate system-prompt tokens from base_instructions if present
    const sys = payload.base_instructions?.text
    if (typeof sys === 'string' && sys.length > 0) {
      state.contextBreakdown.systemPrompt = Math.max(
        estimateTokensFromText(sys),
        SYSTEM_PROMPT_BASE_TOKENS,
      )
    }
    this.emitContextUpdate(state)
  }

  // ─── turn_context ────────────────────────────────────────────────────────

  private handleTurnContext(payload: TurnContextPayload | undefined, state: CodexRolloutState): void {
    if (!payload) return
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd
    if (typeof payload.model === 'string' && payload.model !== state.lastEmittedModel) {
      state.model = payload.model
      state.lastEmittedModel = payload.model
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'model_detected',
        payload: { agent: ORCHESTRATOR_NAME, model: payload.model },
      })
    }
  }

  // ─── response_item ───────────────────────────────────────────────────────

  private handleResponseItem(payload: unknown, state: CodexRolloutState): void {
    if (!isRecord(payload)) return
    const itemType = payload.type
    switch (itemType) {
      case 'message':
        return this.handleMessage(payload as MessagePayload, state)
      case 'function_call':
        return this.handleFunctionCall(payload as FunctionCallPayload, state)
      case 'function_call_output':
        return this.handleFunctionCallOutput(payload as FunctionCallOutputPayload, state)
      case 'custom_tool_call':
        return this.handleCustomToolCall(payload as CustomToolCallPayload, state)
      case 'custom_tool_call_output':
        return this.handleCustomToolCallOutput(payload as CustomToolCallOutputPayload, state)
      case 'web_search_call':
        return this.handleWebSearchCall(payload as WebSearchCallPayload)
      // `reasoning` items carry encrypted_content + a short summary; we emit
      // plaintext reasoning from event_msg.agent_reasoning instead.
    }
  }

  private handleMessage(payload: MessagePayload, state: CodexRolloutState): void {
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') return // skip 'developer' and other injected roles

    const rawText = flattenContent(payload.content)
    if (!rawText) return

    // Codex wraps real user prompts inside IDE-context blocks; extract the
    // actual prompt and skip pure injection messages entirely.
    const text = role === 'user' ? extractCodexUserText(rawText) : rawText
    if (!text) return

    const hash = `${role}:${text.slice(0, HASH_PREFIX_MAX)}`
    if (state.seenMessageHashes.has(hash)) return
    state.seenMessageHashes.add(hash)

    if (role === 'user') {
      state.contextBreakdown.userMessages += estimateTokensFromText(text)
      if (!state.label) {
        state.label = text.slice(0, PREVIEW_MAX)
        this.delegate.setLabel?.(state.label)
      }
    }

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: {
        agent: ORCHESTRATOR_NAME,
        role,
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(state)
  }

  private handleFunctionCall(payload: FunctionCallPayload, state: CodexRolloutState): void {
    const name = payload.name || 'unknown'
    const callId = payload.call_id
    if (!callId) return

    const args = parseArgsJson(payload.arguments)
    const argsSummary = summarizeInput(name, args)
    const filePath = extractFilePath(args)

    state.pendingToolCalls.set(callId, {
      name, args: argsSummary, startTime: Date.now(), filePath,
    })

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(name, args ?? {}),
      },
    })
  }

  private handleFunctionCallOutput(payload: FunctionCallOutputPayload, state: CodexRolloutState): void {
    const callId = payload.call_id
    if (!callId) return
    const pending = state.pendingToolCalls.get(callId)
    if (!pending) return
    state.pendingToolCalls.delete(callId)

    const output = extractOutputString(payload.output)
    const resultSummary = summarizeResult(output).slice(0, RESULT_MAX)
    const tokenCost = estimateTokenCost(pending.name, output)
    state.contextBreakdown.toolResults += tokenCost

    const isError = detectError(output)
    const discovery = buildDiscovery(pending.name, pending.filePath, output)

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: pending.name,
        result: resultSummary,
        tokenCost,
        ...(isError ? { isError: true, errorMessage: resultSummary } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })
    this.emitContextUpdate(state)
  }

  private handleCustomToolCall(payload: CustomToolCallPayload, state: CodexRolloutState): void {
    const name = payload.name || 'unknown'
    const callId = payload.call_id
    if (!callId) return

    // Custom tool input is a raw string (e.g. the full apply_patch body), not JSON.
    const rawInput = typeof payload.input === 'string' ? payload.input : ''
    const argsSummary = summarizeInput(name, { patch: rawInput })
    const filePath = extractPatchFilePath(rawInput)

    state.pendingToolCalls.set(callId, {
      name, args: argsSummary, startTime: Date.now(), filePath,
    })

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(name, { patch: rawInput }),
      },
    })
  }

  private handleCustomToolCallOutput(payload: CustomToolCallOutputPayload, state: CodexRolloutState): void {
    // Same shape as function_call_output for our purposes.
    this.handleFunctionCallOutput(payload, state)
  }

  private handleWebSearchCall(payload: WebSearchCallPayload): void {
    const query = String(payload.action?.query || '')
    if (!query) return
    // Web search is self-contained — emit start + end together.
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: 'WebSearch',
        args: query,
        preview: `WebSearch: ${query}`.slice(0, PREVIEW_MAX),
        inputData: { query },
      },
    })
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tool: 'WebSearch',
        result: payload.status || 'completed',
        tokenCost: 0,
      },
    })
  }

  // ─── event_msg ───────────────────────────────────────────────────────────

  private handleEventMsg(payload: unknown, state: CodexRolloutState): void {
    if (!isRecord(payload)) return
    switch (payload.type) {
      case 'agent_reasoning':
        return this.handleAgentReasoning(payload, state)
      case 'token_count':
        return this.handleTokenCount(payload, state)
      // Other event_msg types are either mirrors of response_item content
      // (agent_message, user_message, exec_command_end, patch_apply_end) or
      // metadata we don't currently surface (task_started, task_complete,
      // turn_aborted, context_compacted — the latter paired with the
      // top-level `compacted` record which we handle authoritatively).
    }
  }

  /** Codex reports authoritative token usage per turn. Prefer it over our
   *  text-length estimates whenever info is populated.
   *
   *  - `last_token_usage.input_tokens` = size of this turn's prompt = current
   *    context fill (what the gauge should show).
   *  - `total_token_usage.input_tokens` = cumulative across the session — used
   *    for billing, not context fill.
   *  - `model_context_window` = authoritative tokensMax for this model. */
  private handleTokenCount(payload: Record<string, unknown>, state: CodexRolloutState): void {
    const info = payload.info
    if (!isRecord(info)) return

    if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      state.reportedContextWindow = info.model_context_window
    }

    const last = info.last_token_usage
    if (isRecord(last) && typeof last.input_tokens === 'number' && last.input_tokens > 0) {
      state.lastReportedTokens = last.input_tokens
      const reasoning = typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0
      // Re-slice the breakdown so it sums to the authoritative total.
      // Codex doesn't expose user/tool split, so bucket everything non-reasoning
      // under toolResults as a catch-all (systemPrompt is estimated from
      // base_instructions and kept constant).
      state.contextBreakdown.reasoning = reasoning
      state.contextBreakdown.userMessages = 0
      state.contextBreakdown.subagentResults = 0
      state.contextBreakdown.toolResults = Math.max(
        0,
        last.input_tokens - state.contextBreakdown.systemPrompt - reasoning,
      )
    }

    this.emitContextUpdate(state, { authoritative: true })
  }

  private handleAgentReasoning(payload: Record<string, unknown>, state: CodexRolloutState): void {
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return

    const hash = `thinking:${text.slice(0, HASH_PREFIX_MAX)}`
    if (state.seenMessageHashes.has(hash)) return
    state.seenMessageHashes.add(hash)

    state.contextBreakdown.reasoning += estimateTokensFromText(text)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: {
        agent: ORCHESTRATOR_NAME,
        role: 'thinking',
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(state)
  }

  // ─── compacted ───────────────────────────────────────────────────────────

  private handleCompacted(payload: CompactedPayload | undefined, state: CodexRolloutState): void {
    if (!payload) return
    // After compaction, the model's working context is limited to
    // replacement_history. Recompute userMessages/reasoning token totals
    // from that new baseline; keep systemPrompt.
    let userTokens = 0
    let toolResultTokens = 0
    for (const entry of payload.replacement_history ?? []) {
      if (entry?.role === 'user') {
        userTokens += estimateTokensFromText(flattenContent(entry.content))
      } else if (entry?.role === 'tool' || entry?.type === 'tool_result') {
        toolResultTokens += estimateTokensFromText(flattenContent(entry.content))
      }
    }
    state.contextBreakdown.userMessages = userTokens
    state.contextBreakdown.toolResults = toolResultTokens
    state.contextBreakdown.reasoning = 0
    state.contextBreakdown.subagentResults = 0
    // systemPrompt stays — it's the base instructions, still counted.
    this.emitContextUpdate(state)
    log.info('Context compacted — token breakdown reset from replacement_history')
  }

  // ─── Shared helpers ──────────────────────────────────────────────────────

  private emitContextUpdate(
    state: CodexRolloutState,
    opts: { authoritative?: boolean } = {},
  ): void {
    const bd = state.contextBreakdown
    const estimated = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
    // Prefer the authoritative total from event_msg.token_count when available.
    const tokens = state.lastReportedTokens ?? estimated
    // Flag events where Codex just reported token_count so the UI can smooth
    // the estimate→authoritative transition instead of jumping. Non-authoritative
    // updates still ride on lastReportedTokens once it's been set, but the
    // breakdown itself is our estimate until the next token_count arrives.
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'context_update',
      payload: {
        agent: ORCHESTRATOR_NAME,
        tokens,
        breakdown: { ...bd },
        ...(state.reportedContextWindow ? { tokensMax: state.reportedContextWindow } : {}),
        ...(opts.authoritative ? { isAuthoritative: true } : {}),
      },
    })
  }
}
