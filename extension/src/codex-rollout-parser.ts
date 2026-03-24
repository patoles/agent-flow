import { AgentEvent, PendingToolCall, emitSubagentSpawn } from './protocol'
import {
  MESSAGE_MAX, ORCHESTRATOR_NAME, RESULT_MAX,
  SYSTEM_PROMPT_BASE_TOKENS,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery, detectError,
} from './tool-summarizer'
import { estimateTokenCost, estimateTokensFromText } from './token-estimator'

export interface CodexContextBreakdown {
  systemPrompt: number
  userMessages: number
  toolResults: number
  reasoning: number
  subagentResults: number
}

export interface CodexSubagentInfo {
  id?: string
  name: string
  task: string
  parent: string
  spawned: boolean
  completed: boolean
}

export interface CodexRolloutState {
  pendingToolCalls: Map<string, PendingToolCall>
  permissionPendingToolCalls: Map<string, PendingToolCall>
  seenMessageHashes: Set<string>
  contextBreakdown: CodexContextBreakdown
  subagentsByCallId: Map<string, CodexSubagentInfo>
  subagentsById: Map<string, CodexSubagentInfo>
  waitTargetsByCallId: Map<string, string[]>
  subagentResultSummaryById: Map<string, string>
}

export interface CodexParserDelegate {
  emit(event: AgentEvent): void
}

interface CodexRolloutRecord {
  timestamp?: string
  type?: string
  payload?: unknown
}

interface CodexMessageContentItem {
  type?: string
  text?: string
}

interface CodexMessagePayload {
  role?: string
  content?: CodexMessageContentItem[]
}

interface CodexFunctionCallPayload {
  name?: string
  arguments?: string
  call_id?: string
}

interface CodexFunctionCallOutputPayload {
  call_id?: string
  output?: string
}

interface CodexCustomToolCallPayload {
  name?: string
  input?: string
  call_id?: string
}

interface CodexCustomToolCallOutputPayload {
  call_id?: string
  output?: string
}

interface CodexWebSearchPayload {
  status?: string
  action?: {
    type?: string
    query?: string
  }
}

interface CodexReasoningPayload {
  summary?: Array<{ text?: string } | string>
}

interface NormalizedToolCall {
  toolName: string
  input: Record<string, unknown>
  argsSummary: string
  inputData?: Record<string, unknown>
  filePath?: string
  trackPermission: boolean
}

interface ParsedToolOutput {
  summary: string
  parsed?: unknown
  isError: boolean
}

interface CodexSubagentNotification {
  agent_id?: string
  status?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeParseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function textFromContent(items: CodexMessageContentItem[] | undefined): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function parseSubagentNotification(text: string): CodexSubagentNotification | null {
  const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/i)
  if (!match?.[1]) return null
  const parsed = safeParseJson(match[1])
  return isRecord(parsed) ? parsed as CodexSubagentNotification : null
}

function normalizeExecCommand(input: Record<string, unknown>): NormalizedToolCall {
  const normalizedInput = {
    command: String(input.cmd || ''),
    description: typeof input.justification === 'string' ? input.justification : '',
    workdir: typeof input.workdir === 'string' ? input.workdir : '',
  }
  return {
    toolName: 'Bash',
    input: normalizedInput,
    argsSummary: summarizeInput('Bash', normalizedInput),
    inputData: extractInputData('Bash', normalizedInput),
    trackPermission: true,
  }
}

function resolveSpawnAgentTask(input: Record<string, unknown>): string {
  if (typeof input.message === 'string' && input.message.trim()) return input.message.trim()
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim()
      }
    }
  }
  if (typeof input.agent_type === 'string' && input.agent_type.trim()) return `${input.agent_type} subagent`
  return 'subagent task'
}

function normalizeSpawnAgent(input: Record<string, unknown>): NormalizedToolCall {
  const task = resolveSpawnAgentTask(input)
  const normalizedInput = {
    description: task,
    prompt: task,
    agent_type: typeof input.agent_type === 'string' ? input.agent_type : '',
  }
  return {
    toolName: 'Agent',
    input: normalizedInput,
    argsSummary: summarizeInput('Agent', normalizedInput),
    trackPermission: false,
  }
}

function normalizeWaitAgent(input: Record<string, unknown>): NormalizedToolCall {
  return {
    toolName: 'wait_agent',
    input,
    argsSummary: summarizeInput('wait_agent', input),
    trackPermission: false,
  }
}

function normalizeSendInput(input: Record<string, unknown>): NormalizedToolCall {
  return {
    toolName: 'send_input',
    input,
    argsSummary: summarizeInput('send_input', input),
    trackPermission: false,
  }
}

function normalizeCloseAgent(input: Record<string, unknown>): NormalizedToolCall {
  return {
    toolName: 'close_agent',
    input,
    argsSummary: summarizeInput('close_agent', input),
    trackPermission: false,
  }
}

function normalizeParallel(input: Record<string, unknown>): NormalizedToolCall {
  return {
    toolName: 'Parallel',
    input,
    argsSummary: summarizeInput('Parallel', input),
    trackPermission: false,
  }
}

function normalizeGenericTool(name: string, input: Record<string, unknown>): NormalizedToolCall {
  const filePath = extractFilePath(input)
  return {
    toolName: name,
    input,
    argsSummary: summarizeInput(name, input),
    inputData: extractInputData(name, input),
    filePath,
    trackPermission: ['Read', 'Write', 'Edit', 'Bash'].includes(name),
  }
}

function normalizeCustomTool(name: string, rawInput: string): NormalizedToolCall {
  const input: Record<string, unknown> = { patch: rawInput }
  const filePath = extractFilePath(input)
  return {
    toolName: name === 'apply_patch' ? 'Patch' : name,
    input,
    argsSummary: summarizeInput(name === 'apply_patch' ? 'Patch' : name, input),
    filePath,
    trackPermission: name === 'apply_patch',
  }
}

function normalizeToolCall(name: string, rawArguments: string | undefined, sourceType: 'function' | 'custom'): NormalizedToolCall {
  const parsed = safeParseJson(rawArguments)
  const input = isRecord(parsed) ? parsed : {}

  if (sourceType === 'function') {
    switch (name) {
      case 'exec_command':
        return normalizeExecCommand(input)
      case 'spawn_agent':
        return normalizeSpawnAgent(input)
      case 'wait_agent':
        return normalizeWaitAgent(input)
      case 'send_input':
        return normalizeSendInput(input)
      case 'close_agent':
        return normalizeCloseAgent(input)
      case 'multi_tool_use.parallel':
        return normalizeParallel(input)
      default:
        return normalizeGenericTool(name, input)
    }
  }

  return normalizeCustomTool(name, rawArguments || '')
}

function parseOutput(rawOutput: string | undefined): ParsedToolOutput {
  const text = String(rawOutput || '')
  const parsed = safeParseJson(text)

  let summary = text
  let isError = detectError(text)

  if (isRecord(parsed)) {
    if (typeof parsed.output === 'string') {
      summary = parsed.output
    } else if (typeof parsed.message === 'string') {
      summary = parsed.message
    } else if (typeof parsed.nickname === 'string') {
      summary = `Spawned ${parsed.nickname}`
    } else if (parsed.timed_out === true) {
      summary = 'Timed out'
    } else {
      summary = JSON.stringify(parsed)
    }

    const metadata = parsed.metadata
    if (isRecord(metadata) && typeof metadata.exit_code === 'number' && metadata.exit_code !== 0) {
      isError = true
    }
    if (typeof parsed.status === 'string' && parsed.status.toLowerCase() === 'error') {
      isError = true
    }
  }

  const nonZeroExit = /process exited with code ([1-9]\d*)/i.test(summary)
  return { summary, parsed, isError: isError || nonZeroExit }
}

export function createCodexRolloutState(): CodexRolloutState {
  return {
    pendingToolCalls: new Map(),
    permissionPendingToolCalls: new Map(),
    seenMessageHashes: new Set(),
    contextBreakdown: {
      systemPrompt: SYSTEM_PROMPT_BASE_TOKENS,
      userMessages: 0,
      toolResults: 0,
      reasoning: 0,
      subagentResults: 0,
    },
    subagentsByCallId: new Map(),
    subagentsById: new Map(),
    waitTargetsByCallId: new Map(),
    subagentResultSummaryById: new Map(),
  }
}

export function extractCodexTimestampMs(line: string): number | null {
  try {
    const parsed = JSON.parse(line.trim()) as CodexRolloutRecord
    if (typeof parsed.timestamp !== 'string') return null
    const ms = Date.parse(parsed.timestamp)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export class CodexRolloutParser {
  constructor(
    private readonly delegate: CodexParserDelegate,
    private readonly sessionId: string,
    private readonly sessionStartTimeMs: number,
    private readonly state: CodexRolloutState,
    private readonly agentName = ORCHESTRATOR_NAME,
  ) {}

  processLine(line: string): void {
    const record = this.parseRecord(line)
    if (!record || record.type !== 'response_item' || !isRecord(record.payload)) return

    const payloadType = typeof record.payload.type === 'string' ? record.payload.type : ''
    switch (payloadType) {
      case 'message':
        this.handleMessage(record.payload as CodexMessagePayload, record.timestampMs)
        break
      case 'function_call':
        this.handleFunctionCall(record.payload as CodexFunctionCallPayload, record.timestampMs)
        break
      case 'function_call_output':
        this.handleFunctionCallOutput(record.payload as CodexFunctionCallOutputPayload, record.timestampMs)
        break
      case 'custom_tool_call':
        this.handleCustomToolCall(record.payload as CodexCustomToolCallPayload, record.timestampMs)
        break
      case 'custom_tool_call_output':
        this.handleCustomToolCallOutput(record.payload as CodexCustomToolCallOutputPayload, record.timestampMs)
        break
      case 'web_search_call':
        this.handleWebSearch(record.payload as CodexWebSearchPayload, record.timestampMs)
        break
      case 'reasoning':
        this.handleReasoning(record.payload as CodexReasoningPayload, record.timestampMs)
        break
    }
  }

  private parseRecord(line: string): { type: string; payload: Record<string, unknown>; timestampMs: number } | null {
    try {
      const parsed = JSON.parse(line.trim()) as CodexRolloutRecord
      if (typeof parsed.type !== 'string' || !isRecord(parsed.payload)) return null
      const timestampMs = typeof parsed.timestamp === 'string'
        ? Date.parse(parsed.timestamp)
        : this.sessionStartTimeMs
      return {
        type: parsed.type,
        payload: parsed.payload,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : this.sessionStartTimeMs,
      }
    } catch {
      return null
    }
  }

  private eventTime(timestampMs: number): number {
    return Math.max(0, (timestampMs - this.sessionStartTimeMs) / 1000)
  }

  private emit(event: AgentEvent): void {
    this.delegate.emit({ ...event, sessionId: this.sessionId })
  }

  private emitContextUpdate(timestampMs: number): void {
    const bd = this.state.contextBreakdown
    const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
    this.emit({
      time: this.eventTime(timestampMs),
      type: 'context_update',
      payload: {
        agent: this.agentName,
        tokens: total,
        breakdown: { ...bd },
      },
    })
  }

  private handleMessage(payload: CodexMessagePayload, timestampMs: number): void {
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') return

    const text = textFromContent(payload.content)
    if (!text) return

    if (role === 'user') {
      const notification = parseSubagentNotification(text)
      if (notification) {
        this.handleSubagentNotification(notification, timestampMs)
        return
      }
    }

    const hash = `${role}:${timestampMs}:${text.slice(0, 200)}`
    if (this.state.seenMessageHashes.has(hash)) return
    this.state.seenMessageHashes.add(hash)

    if (role === 'user') {
      this.state.contextBreakdown.userMessages += estimateTokensFromText(text)
    } else {
      this.state.contextBreakdown.reasoning += estimateTokensFromText(text)
    }

    this.emit({
      time: this.eventTime(timestampMs),
      type: 'message',
      payload: {
        agent: this.agentName,
        role,
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(timestampMs)
  }

  private handleReasoning(payload: CodexReasoningPayload, timestampMs: number): void {
    if (!Array.isArray(payload.summary) || payload.summary.length === 0) return
    const text = payload.summary
      .map((item) => typeof item === 'string' ? item : item?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!text) return

    this.state.contextBreakdown.reasoning += estimateTokensFromText(text)
    this.emit({
      time: this.eventTime(timestampMs),
      type: 'message',
      payload: {
        agent: this.agentName,
        role: 'thinking',
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(timestampMs)
  }

  private handleFunctionCall(payload: CodexFunctionCallPayload, timestampMs: number): void {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
    const name = typeof payload.name === 'string' ? payload.name : undefined
    if (!callId || !name) return

    const normalized = normalizeToolCall(name, payload.arguments, 'function')
    this.registerToolStart(callId, normalized, timestampMs)
  }

  private handleFunctionCallOutput(payload: CodexFunctionCallOutputPayload, timestampMs: number): void {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
    if (!callId) return
    this.registerToolEnd(callId, payload.output, timestampMs)
  }

  private handleCustomToolCall(payload: CodexCustomToolCallPayload, timestampMs: number): void {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
    const name = typeof payload.name === 'string' ? payload.name : undefined
    if (!callId || !name) return

    const normalized = normalizeToolCall(name, payload.input, 'custom')
    this.registerToolStart(callId, normalized, timestampMs)
  }

  private handleCustomToolCallOutput(payload: CodexCustomToolCallOutputPayload, timestampMs: number): void {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
    if (!callId) return
    this.registerToolEnd(callId, payload.output, timestampMs)
  }

  private handleWebSearch(payload: CodexWebSearchPayload, timestampMs: number): void {
    if (payload.status !== 'completed' || !isRecord(payload.action)) return
    const query = typeof payload.action.query === 'string' ? payload.action.query.trim() : ''
    if (!query) return

    const inputData = { query }
    const toolName = 'WebSearch'
    this.emit({
      time: this.eventTime(timestampMs),
      type: 'tool_call_start',
      payload: {
        agent: this.agentName,
        tool: toolName,
        args: summarizeInput(toolName, inputData),
        inputData: extractInputData(toolName, inputData),
      },
    })
    this.emit({
      time: this.eventTime(timestampMs),
      type: 'tool_call_end',
      payload: {
        agent: this.agentName,
        tool: toolName,
        result: 'Search completed',
        tokenCost: estimateTokenCost(toolName, query),
      },
    })
  }

  private registerToolStart(callId: string, normalized: NormalizedToolCall, timestampMs: number): void {
    const pending: PendingToolCall = {
      name: normalized.toolName,
      args: normalized.argsSummary,
      filePath: normalized.filePath,
      startTime: timestampMs,
    }

    this.state.pendingToolCalls.set(callId, pending)
    if (normalized.trackPermission) {
      this.state.permissionPendingToolCalls.set(callId, pending)
    }

    if (normalized.toolName === 'Agent') {
      this.state.subagentsByCallId.set(callId, {
        name: normalized.argsSummary || 'subagent',
        task: normalized.argsSummary || 'subagent task',
        parent: this.agentName,
        spawned: false,
        completed: false,
      })
    } else if (normalized.toolName === 'wait_agent') {
      this.state.waitTargetsByCallId.set(callId, extractStringArray(normalized.input.ids))
    }

    this.emit({
      time: this.eventTime(timestampMs),
      type: 'tool_call_start',
      payload: {
        agent: this.agentName,
        tool: normalized.toolName,
        args: normalized.argsSummary,
        ...(normalized.inputData ? { inputData: normalized.inputData } : {}),
      },
    })
  }

  private registerToolEnd(callId: string, rawOutput: string | undefined, timestampMs: number): void {
    const pending = this.state.pendingToolCalls.get(callId)
    if (!pending) return

    this.state.pendingToolCalls.delete(callId)
    this.state.permissionPendingToolCalls.delete(callId)

    const parsedOutput = parseOutput(rawOutput)
    const resultText = parsedOutput.summary
    const tokenCost = estimateTokenCost(pending.name, resultText)
    const discovery = buildDiscovery(pending.name, pending.filePath, resultText)

    this.state.contextBreakdown.toolResults += estimateTokensFromText(resultText)

    this.emit({
      time: this.eventTime(timestampMs),
      type: 'tool_call_end',
      payload: {
        agent: this.agentName,
        tool: pending.name,
        result: summarizeResult(resultText).slice(0, RESULT_MAX),
        tokenCost,
        ...(parsedOutput.isError ? { isError: true, errorMessage: resultText.slice(0, RESULT_MAX) } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })

    if (pending.name === 'wait_agent') {
      const waitSummary = this.extractWaitSummary(parsedOutput)
      const targetIds = this.state.waitTargetsByCallId.get(callId) ?? []
      if (waitSummary) {
        for (const agentId of targetIds) {
          this.state.subagentResultSummaryById.set(agentId, waitSummary)
        }
      }
      this.state.waitTargetsByCallId.delete(callId)
    }

    this.handleSubagentSpawn(callId, pending, parsedOutput, timestampMs)
    this.emitContextUpdate(timestampMs)
  }

  private handleSubagentSpawn(callId: string, pending: PendingToolCall, parsedOutput: ParsedToolOutput, timestampMs: number): void {
    if (pending.name !== 'Agent' || !isRecord(parsedOutput.parsed)) return

    const pendingSubagent = this.state.subagentsByCallId.get(callId)
    const agentId = typeof parsedOutput.parsed.agent_id === 'string' ? parsedOutput.parsed.agent_id : undefined
    const nickname = typeof parsedOutput.parsed.nickname === 'string' ? parsedOutput.parsed.nickname : undefined
    if (!pendingSubagent || !nickname) return

    const child: CodexSubagentInfo = {
      ...pendingSubagent,
      id: agentId,
      name: nickname,
      spawned: true,
    }
    this.state.subagentsByCallId.set(callId, child)
    if (agentId) this.state.subagentsById.set(agentId, child)

    emitSubagentSpawn(
      {
        emit: (event) => this.emit(event),
        elapsed: () => this.eventTime(timestampMs),
      },
      this.agentName,
      child.name,
      child.task,
      this.sessionId,
    )
  }

  private extractWaitSummary(parsedOutput: ParsedToolOutput): string | undefined {
    if (!isRecord(parsedOutput.parsed) || parsedOutput.parsed.timed_out === true) return undefined

    const parsed = parsedOutput.parsed
    if (typeof parsed.final_message === 'string' && parsed.final_message.trim()) {
      return parsed.final_message.trim()
    }

    const status = parsed.status
    if (isRecord(status)) {
      if (typeof status.final_message === 'string' && status.final_message.trim()) {
        return status.final_message.trim()
      }
      if (typeof status.message === 'string' && status.message.trim()) {
        return status.message.trim()
      }
    }

    if (typeof parsedOutput.summary === 'string' && parsedOutput.summary.trim() && parsedOutput.summary !== '{}') {
      return parsedOutput.summary.trim()
    }

    return undefined
  }

  private handleSubagentNotification(notification: CodexSubagentNotification, timestampMs: number): void {
    const agentId = typeof notification.agent_id === 'string' ? notification.agent_id : undefined
    const status = typeof notification.status === 'string' ? notification.status.toLowerCase() : ''
    if (!agentId || status !== 'shutdown') return

    const child = this.state.subagentsById.get(agentId)
    if (!child || child.completed) return

    child.completed = true
    this.state.subagentsById.set(agentId, child)

    const summary = this.state.subagentResultSummaryById.get(agentId) || 'Completed'
    this.state.contextBreakdown.subagentResults += estimateTokensFromText(summary)

    this.emit({
      time: this.eventTime(timestampMs),
      type: 'subagent_return',
      payload: {
        parent: child.parent,
        child: child.name,
        summary: summary.slice(0, MESSAGE_MAX),
      },
    })
    this.emit({
      time: this.eventTime(timestampMs),
      type: 'agent_complete',
      payload: {
        name: child.name,
      },
    })
    this.emitContextUpdate(timestampMs)
  }
}
