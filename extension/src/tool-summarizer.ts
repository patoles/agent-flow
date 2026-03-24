/**
 * Shared tool summarization utilities.
 * Extracts duplicated logic from session-watcher.ts and hook-server.ts.
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

/** Extract patch target paths from apply_patch-style input */
export function extractPatchPaths(patchText: string): string[] {
  const matches = patchText.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)
  return Array.from(matches, (match) => match[1]).filter(Boolean)
}

function summarizePatchInput(input: Record<string, unknown>): string {
  const patchText = String(input.patch || '')
  const paths = extractPatchPaths(patchText)
  if (paths.length === 1) return `${tailPath(paths[0])} — patch`
  if (paths.length > 1) return `${paths.length} files — patch`
  return 'apply patch'
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
    case 'Patch':
      return summarizePatchInput(input).slice(0, ARGS_MAX)
    case 'Parallel': {
      const toolUses = input.tool_uses
      return Array.isArray(toolUses) ? `${toolUses.length} parallel tool calls` : 'parallel tool calls'
    }
    case 'wait_agent': {
      const ids = input.ids
      return Array.isArray(ids)
        ? `wait ${ids.length} agent${ids.length === 1 ? '' : 's'}`
        : 'wait for agent'
    }
    case 'send_input':
      return String(input.message || input.id || '').slice(0, ARGS_MAX)
    case 'close_agent':
      return String(input.id || 'close agent').slice(0, ARGS_MAX)
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
      case 'Patch': {
        const paths = extractPatchPaths(String(input.patch || ''))
        return {
          file_path: paths[0] || '',
        }
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
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.patch === 'string') {
    const paths = extractPatchPaths(input.patch)
    return paths.length === 1 ? paths[0] : undefined
  }
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
