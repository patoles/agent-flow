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

/**
 * Heuristic fallback summarizer for unknown / custom tools.
 *
 * Instead of JSON-dumping the entire input (which is unreadable at 80 chars),
 * we try a prioritised list of "most-useful" keys common across tool families:
 *   command / query / url / message / content / path / file_path / description / prompt
 * If none match, fall back to the first string value found in the object.
 */
function summarizeFallback(toolName: string, input?: Record<string, unknown>): string {
  if (!input) { return '' }

  const priorities = [
    'command',     // shell-execution family
    'query',       // search family
    'url',         // fetch / browser family
    'message',     // communication / messaging family
    'content',     // write / store family
    'task',        // spawn / orchestration family
    'description', // task / agent family
    'prompt',      // task / agent family
    'path',        // file family
    'file_path',   // file family
    'action',      // action-based tools (browser, message, etc.)
    'text',        // generic text
  ]

  for (const key of priorities) {
    const val = input[key]
    if (typeof val === 'string' && val.trim()) {
      const prefix = key === 'action' ? `${val}: ` : ''
      if (prefix) {
        // For action-based tools, include the target/element too
        const target = input.target || input.element || input.selector || ''
        return (prefix + String(target || '')).slice(0, ARGS_MAX)
      }
      return val.slice(0, ARGS_MAX)
    }
  }

  // Last resort: first string value in the object
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.trim()) {
      return val.slice(0, ARGS_MAX)
    }
  }

  return JSON.stringify(input).slice(0, ARGS_MAX)
}

/** Summarize tool input into a short human-readable string */
export function summarizeInput(toolName: string, input?: Record<string, unknown>): string {
  if (!input) { return '' }
  switch (toolName) {
    // ── Built-in Claude Code tools ────────────────────────────────────────
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

    // ── Custom / OpenClaw tool aliases ────────────────────────────────────
    // exec: shell execution (custom Claude Code environments)
    case 'exec': {
      const cmd = String(input.command || '').slice(0, ARGS_MAX)
      const cwd = input.workdir ? ` (${tailPath(String(input.workdir), 1)})` : ''
      return (cmd + cwd).slice(0, ARGS_MAX)
    }

    // process: manage running exec sessions (list/poll/log/write/kill)
    case 'process': {
      const action = String(input.action || '')
      const sid = input.sessionId ? String(input.sessionId).slice(0, 8) : ''
      return sid ? `${action} ${sid}` : action
    }

    // browser: browser automation
    case 'browser': {
      const action = String(input.action || '')
      const url = input.url ? (() => {
        try { const u = new URL(String(input.url)); return u.hostname + u.pathname.slice(0, URL_PATH_MAX) } catch { return String(input.url).slice(0, 30) }
      })() : ''
      const element = input.element ? String(input.element).slice(0, 30) : ''
      return [action, url || element].filter(Boolean).join(': ').slice(0, ARGS_MAX)
    }

    // web_search: web search (underscore variant)
    case 'web_search':
      return String(input.query || '').slice(0, ARGS_MAX)

    // web_fetch: URL fetch (underscore variant)
    case 'web_fetch': {
      const url = String(input.url || '')
      try { const u = new URL(url); return u.hostname + u.pathname.slice(0, URL_PATH_MAX) } catch { return url.slice(0, ARGS_MAX) }
    }

    // memory tools
    case 'memory_search':
      return String(input.query || '').slice(0, ARGS_MAX)
    case 'memory_store':
      return String(input.content || '').slice(0, ARGS_MAX)
    case 'memory_profile':
    case 'memory_entities':
    case 'memory_questions':
    case 'memory_identity':
      return input.name ? String(input.name) : ''

    // sessions / subagent spawning
    case 'sessions_spawn': {
      const task = String(input.task || '').slice(0, TASK_MAX)
      const mode = input.mode ? ` [${input.mode}]` : ''
      return (task + mode).slice(0, ARGS_MAX)
    }
    case 'sessions_send':
      return String(input.message || '').slice(0, ARGS_MAX)
    case 'sessions_list':
    case 'sessions_history':
      return input.sessionKey ? String(input.sessionKey).slice(0, ARGS_MAX) : 'list sessions'

    // messaging (Slack / WhatsApp / etc.)
    case 'message': {
      const action = String(input.action || '')
      const target = input.target ? ` → ${String(input.target).slice(0, 20)}` : ''
      const msg = input.message ? `: ${String(input.message).slice(0, 30)}` : ''
      return (action + target + msg).slice(0, ARGS_MAX)
    }

    default:
      return summarizeFallback(toolName, input)
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
      case 'exec':
        return {
          command: String(input.command || ''),
          description: String(input.description || ''),
          ...(input.workdir ? { workdir: String(input.workdir) } : {}),
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
      case 'web_search':
        return {
          query: String(input.query || ''),
        }
      case 'WebFetch':
      case 'web_fetch':
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
      case 'browser':
        return {
          action: String(input.action || ''),
          ...(input.url ? { url: String(input.url) } : {}),
          ...(input.element ? { element: String(input.element) } : {}),
          ...(input.selector ? { selector: String(input.selector) } : {}),
        }
      case 'memory_search':
        return {
          query: String(input.query || ''),
          ...(input.maxResults ? { maxResults: input.maxResults } : {}),
          ...(input.namespace ? { namespace: String(input.namespace) } : {}),
        }
      case 'memory_store':
        return {
          content: String(input.content || '').slice(0, EDIT_CONTENT_MAX),
          ...(input.category ? { category: String(input.category) } : {}),
        }
      case 'sessions_spawn':
        return {
          task: String(input.task || '').slice(0, EDIT_CONTENT_MAX),
          ...(input.agentId ? { agentId: String(input.agentId) } : {}),
          ...(input.mode ? { mode: String(input.mode) } : {}),
        }
      case 'message':
        return {
          action: String(input.action || ''),
          ...(input.target ? { target: String(input.target) } : {}),
          ...(input.message ? { message: String(input.message).slice(0, EDIT_CONTENT_MAX) } : {}),
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
