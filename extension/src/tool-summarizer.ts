/**
 * Shared tool summarization utilities for Claude Code tools.
 * Extracts duplicated logic from session-watcher.ts and hook-server.ts.
 *
 * Claude-only by convention: Codex tool summaries are produced inline in
 * codex-rollout-parser.ts because Codex's function_call shape and tool names
 * (exec_command, apply_patch, update_plan, write_stdin, web_search_call, …)
 * don't overlap with Claude's. If a future refactor unifies them, this
 * module would become the natural home — but until then, don't add Codex
 * cases here without a plan for dispatching by runtime.
 */

import {
  ARGS_MAX, RESULT_MAX, TASK_MAX,
  EDIT_CONTENT_MAX, WEB_FETCH_PROMPT_MAX,
  SKILL_NAME_MAX, URL_PATH_MAX,
  DISCOVERY_LABEL_MAX, DISCOVERY_LABEL_TAIL, DISCOVERY_CONTENT_MAX,
  FILE_TOOLS, PATTERN_TOOLS,
} from './constants'

/** Truncate a file path to the last N segments (e.g. '/a/b/c/d.ts' → 'c/d.ts') */
function tailPath(filePath: string, segments = 2): string {
  return String(filePath).split('/').slice(-segments).join('/')
}

/** Summarize tool input into a short human-readable string */
export function summarizeInput(toolName: string, input?: Record<string, unknown>): string {
  if (!input) { return '' }
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, ARGS_MAX)
    case 'Read':
      return tailPath(String(input.file_path || input.path || ''))
    case 'Edit':
      return tailPath(String(input.file_path || '')) + ' — edit'
    case 'Write':
      return tailPath(String(input.file_path || '')) + ' — write'
    case 'Glob':
      return String(input.pattern || '')
    case 'Grep':
      return String(input.pattern || '')
    case 'Task':
    case 'Agent':
      return String(input.description || input.prompt || '').slice(0, TASK_MAX)
    case 'TodoWrite': {
      const todos = input.todos as Array<{ content?: string; activeForm?: string; status?: string }> | undefined
      if (Array.isArray(todos) && todos.length > 0) {
        const active = todos.find(t => t.status === 'in_progress')
        const label = active?.activeForm || active?.content || todos[0]?.content || 'todos'
        const done = todos.filter(t => t.status === 'completed').length
        return `${label} (${done}/${todos.length})`.slice(0, ARGS_MAX)
      }
      return 'updating todos'
    }
    case 'WebSearch':
      return String(input.query || '').slice(0, ARGS_MAX)
    case 'WebFetch': {
      const url = String(input.url || '')
      try { const u = new URL(url); return u.hostname + u.pathname.slice(0, URL_PATH_MAX) } catch { return url.slice(0, ARGS_MAX) }
    }
    case 'AskUserQuestion': {
      const questions = input.questions as Array<{ question?: string }> | undefined
      if (Array.isArray(questions) && questions[0]?.question) {
        return String(questions[0].question).slice(0, ARGS_MAX)
      }
      return 'asking user...'
    }
    case 'Skill':
      return String(input.skill || '').slice(0, SKILL_NAME_MAX)
    case 'NotebookEdit':
      return tailPath(String(input.notebook_path || '')) + ` cell ${input.cell_number ?? '?'}`
    // ─── Codex tools ────────────────────────────────────────────────────────
    case 'exec_command':
      return String(input.cmd || input.command || '').slice(0, ARGS_MAX)
    case 'write_stdin':
      return String(input.input || input.stdin || '').slice(0, ARGS_MAX)
    case 'update_plan': {
      const items = input.plan as Array<{ step?: string; status?: string }> | undefined
      if (Array.isArray(items) && items.length > 0) {
        const active = items.find(i => i.status === 'in_progress')
        const label = active?.step || items[0]?.step || 'plan'
        const done = items.filter(i => i.status === 'completed').length
        return `${label} (${done}/${items.length})`.slice(0, ARGS_MAX)
      }
      return 'updating plan'
    }
    case 'apply_patch':
      // apply_patch arrives as a custom_tool_call with raw patch text in input.
      // First line usually reads "*** Begin Patch\n*** Update File: /path/..."
      return String(input.patch || '').split('\n').slice(0, 3).join(' ').slice(0, ARGS_MAX) || 'apply patch'
    default:
      return JSON.stringify(input).slice(0, ARGS_MAX)
  }
}

/** Summarize tool result content into a short string */
export function summarizeResult(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, RESULT_MAX)
  }
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') { return c }
      if (c && typeof c === 'object' && 'text' in c) { return String(c.text) }
      return ''
    }).join('\n').slice(0, RESULT_MAX)
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    // Handle objects with known text properties (e.g. { content: string })
    const obj = content as { content?: unknown; text?: unknown }
    if (typeof obj.content === 'string') { return obj.content.slice(0, RESULT_MAX) }
    if (typeof obj.text === 'string') { return obj.text.slice(0, RESULT_MAX) }
    try { return JSON.stringify(content).slice(0, RESULT_MAX) } catch { /* fall through */ }
  }
  return String(content || '').slice(0, RESULT_MAX)
}

/** Extract structured input data for rich display in the transcript */
export function extractInputData(toolName: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!input) { return undefined }
  try {
    switch (toolName) {
      case 'Edit':
        return {
          file_path: String(input.file_path || ''),
          old_string: String(input.old_string || '').slice(0, EDIT_CONTENT_MAX),
          new_string: String(input.new_string || '').slice(0, EDIT_CONTENT_MAX),
        }
      case 'TodoWrite':
        return { todos: input.todos }
      case 'Write':
        return {
          file_path: String(input.file_path || ''),
          content: String(input.content || '').slice(0, EDIT_CONTENT_MAX),
        }
      case 'Bash':
        return {
          command: String(input.command || ''),
          description: String(input.description || ''),
        }
      case 'Read':
        return {
          file_path: String(input.file_path || input.path || ''),
          offset: typeof input.offset === 'number' ? input.offset : undefined,
          limit: typeof input.limit === 'number' ? input.limit : undefined,
        }
      case 'Grep':
        return {
          pattern: String(input.pattern || ''),
          path: String(input.path || ''),
          glob: typeof input.glob === 'string' ? input.glob : undefined,
        }
      case 'Glob':
        return {
          pattern: String(input.pattern || ''),
          path: String(input.path || ''),
        }
      case 'WebSearch':
        return {
          query: String(input.query || ''),
        }
      case 'WebFetch':
        return {
          url: String(input.url || ''),
          prompt: String(input.prompt || '').slice(0, WEB_FETCH_PROMPT_MAX),
        }
      case 'AskUserQuestion': {
        const qs = input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> | undefined
        return {
          questions: Array.isArray(qs) ? qs.map(q => ({
            question: String(q.question || ''),
            options: Array.isArray(q.options) ? q.options.map(o => String(o.label || '')) : [],
          })) : [],
        }
      }
      // ─── Codex tools ────────────────────────────────────────────────────
      case 'exec_command':
        return {
          command: String(input.cmd || input.command || ''),
          workdir: typeof input.workdir === 'string' ? input.workdir : undefined,
        }
      case 'apply_patch':
        return {
          patch: String(input.patch || '').slice(0, EDIT_CONTENT_MAX),
        }
      case 'update_plan':
        return { plan: input.plan }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** Extract file path from tool input */
export function extractFilePath(input?: Record<string, unknown>): string | undefined {
  if (!input) { return undefined }
  const raw = input.file_path || input.path
  return typeof raw === 'string' ? raw : undefined
}

/** Build a discovery object for file-related tools, or undefined if not applicable */
export function buildDiscovery(
  toolName: string,
  filePath: string | undefined,
  result: string,
): Record<string, string> | undefined {
  if (!(FILE_TOOLS as readonly string[]).includes(toolName) || !filePath) {
    return undefined
  }
  return {
    type: (PATTERN_TOOLS as readonly string[]).includes(toolName) ? 'pattern' : 'file',
    label: filePath.length > DISCOVERY_LABEL_MAX ? '...' + filePath.slice(-DISCOVERY_LABEL_TAIL) : filePath,
    content: result.slice(0, DISCOVERY_CONTENT_MAX),
  }
}

/** Heuristic error detection in tool output */
export function detectError(content: string): boolean {
  const lower = content.toLowerCase()
  const patterns = [
    'error:', 'error[', 'exception:', 'failed', 'permission denied',
    'command failed', 'cannot find', 'not found', 'enoent',
    'fatal:', 'panic:', 'segfault', 'syntax error',
  ]
  return patterns.some(p => lower.includes(p))
}
