/**
 * Shared constants for the extension.
 * Centralizes magic numbers and strings scattered across modules.
 */

// ─── Timing ──────────────────────────────────────────────────────────────────

/** How long to wait before declaring a session inactive (ms).
 *  Claude can think for several minutes with extended thinking,
 *  so this needs to be generous to avoid false "completed" state. */
export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Interval between active-session directory scans (ms) */
export const SCAN_INTERVAL_MS = 1000

/** Fallback poll interval when fs.watch might miss events (ms) */
export const POLL_FALLBACK_MS = 3000

/** Delay before assuming a pending tool is waiting for permission (ms).
 *  Must be long enough that normal tool execution won't trigger it. */
export const PERMISSION_DETECT_MS = 5000

/** JSONL files modified within this many seconds are considered active
 *  at discovery time. Must be longer than INACTIVITY_TIMEOUT_MS to avoid
 *  dropping sessions during long thinking pauses.
 *
 *  Filter is discovery-time only — stale sessions that receive new writes
 *  refresh their mtime and are picked up by the next scan tick
 *  (SCAN_INTERVAL_MS). A user resuming a long-idle session should see it
 *  attach within ~1s of their next message. */
export const ACTIVE_SESSION_AGE_S = 10 * 60 // 10 minutes

/** Duration of VS Code status bar messages (ms) */
export const STATUS_MESSAGE_DURATION_MS = 5000

/** Max retries for iframe bridge initialization */
export const BRIDGE_INIT_MAX_RETRIES = 50

/** Interval between bridge init retries (ms) */
export const BRIDGE_INIT_RETRY_MS = 100

/** Default dev server port */
export const DEFAULT_DEV_PORT = 3002

/** Default SSE relay port (used by dev relay, standalone app, and webview build) */
export const DEFAULT_RELAY_PORT = 3001

/** Accept CORS requests from any localhost origin during dev — Next.js falls
 *  back to a higher port when 3000 is taken, so a single hard-coded value
 *  would silently break dev. The relay binds to 127.0.0.1 already, so this
 *  pattern is safe (no external origin can reach it). */
export const DEV_WEB_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

/** Returned by HookServer.start() when the port is already in use by another instance */
export const HOOK_SERVER_NOT_STARTED = -1

/** Maximum HTTP request body size for hook server (bytes) */
export const HOOK_MAX_BODY_SIZE = 1024 * 1024 // 1 MB

/** Hook timeout value written to settings.json (seconds) */
export const HOOK_TIMEOUT_S = 2

/** Safety margin subtracted from hook timeout to guarantee exit before kill (ms) */
export const HOOK_SAFETY_MARGIN_MS = 500

/** Timeout for HTTP requests in hook forwarding script (ms) */
export const HOOK_FORWARD_TIMEOUT_MS = 1000

/** Length of workspace hash prefix used in discovery file names */
export const WORKSPACE_HASH_LENGTH = 16

/** Nonce length for CSP nonce generation */
export const NONCE_LENGTH = 32

/** Characters used for CSP nonce generation */
export const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// ─── Webview Colors ─────────────────────────────────────────────────────────

/** Void background color — matches the web COLORS.void value */
export const WEBVIEW_BG_COLOR = '#050510'

/** Loading screen text color (dev mode only) */
export const WEBVIEW_LOADING_TEXT = '#66ccff80'

/** Loading screen dim text color (dev mode only) */
export const WEBVIEW_LOADING_TEXT_DIM = '#66ccff40'

// ─── Text Truncation Limits ──────────────────────────────────────────────────

/** Tool call preview (tool_call_start preview field) */
export const PREVIEW_MAX = 60

/** Tool args / command summaries */
export const ARGS_MAX = 80

/** Tool result summaries */
export const RESULT_MAX = 200

/** Message content sent to the webview */
export const MESSAGE_MAX = 2000

/** Session tab label */
export const SESSION_LABEL_MAX = 14

/** Truncated label text (label - ellipsis) */
export const SESSION_LABEL_TRUNCATED = SESSION_LABEL_MAX - 2

/** File path in discovery labels */
export const DISCOVERY_LABEL_MAX = 40

/** File path tail when truncated (DISCOVERY_LABEL_MAX - 3 for '...') */
export const DISCOVERY_LABEL_TAIL = DISCOVERY_LABEL_MAX - 3

/** Discovery result preview */
export const DISCOVERY_CONTENT_MAX = 100

/** Task description preview */
export const TASK_MAX = 60

/** Edit content preview (old_string/new_string) */
export const EDIT_CONTENT_MAX = 500

/** WebFetch prompt preview */
export const WEB_FETCH_PROMPT_MAX = 200

/** Subagent child name max */
export const CHILD_NAME_MAX = 30

/** Skill name max */
export const SKILL_NAME_MAX = 40

/** WebFetch URL path max */
export const URL_PATH_MAX = 40

/** Session ID display truncation */
export const SESSION_ID_DISPLAY = 8

/** Failed tool result prefix max */
export const FAILED_RESULT_MAX = 100

// ─── Token Estimation ────────────────────────────────────────────────────────

/** Rough chars-per-token ratio for estimation */
export const CHARS_PER_TOKEN = 4

/** Minimum token estimate for any tool result */
export const MIN_TOKEN_ESTIMATE = 10

/** Fallback token estimate when content type is unknown */
export const FALLBACK_TOKEN_ESTIMATE = 200

/** Token multiplier for Grep/Glob results (partial content) */
export const GREP_TOKEN_MULTIPLIER = 0.5

/** Token multiplier for other tool results */
export const DEFAULT_TOKEN_MULTIPLIER = 0.3

/** Base system prompt token estimate */
export const SYSTEM_PROMPT_BASE_TOKENS = 5000

/** Message hash prefix max (for dedup hashing) */
export const HASH_PREFIX_MAX = 200

// ─── Strings ─────────────────────────────────────────────────────────────────

/** Hook server listen address */
export const HOOK_SERVER_HOST = '127.0.0.1'

/** URL prefix for hook server on localhost */
export const HOOK_URL_PREFIX = `http://${HOOK_SERVER_HOST}:`

/** Default agent name for the main orchestrator */
export const ORCHESTRATOR_NAME = 'orchestrator'

/** File-related tools that generate discovery events */
export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const

/** Pattern-based tools (discovery type = 'pattern' instead of 'file') */
export const PATTERN_TOOLS = ['Glob', 'Grep'] as const

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Suffix length used when building subagent names from IDs */
export const SUBAGENT_ID_SUFFIX_LENGTH = 6

/** Generate a consistent fallback name for a subagent when no explicit name is available.
 *  @param id  An identifier string (e.g. agent_id or a timestamp) — the last chars are used.
 *  @param index  A 1-based index for sequential numbering. */
export function generateSubagentFallbackName(id: string, index: number): string {
  return `subagent-${id.length > SUBAGENT_ID_SUFFIX_LENGTH ? id.slice(-SUBAGENT_ID_SUFFIX_LENGTH) : index}`
}

/** Extract a child agent name from a tool_use input block (Agent or Task tool).
 *  Used by both live processing and prescan to avoid duplicating the extraction logic. */
export function resolveSubagentChildName(input: Record<string, unknown>): string {
  return String(input.description || input.subagent_type || 'subagent').slice(0, CHILD_NAME_MAX)
}

/** Prefixes that identify system-injected content (not real user messages)
 *  for Claude Code. Codex has its own extraction in codex-rollout-parser.ts
 *  because the injection format is structurally different (e.g. real prompts
 *  wrapped inside a "# Context from my IDE setup:" block, reachable via the
 *  "## My request for Codex:" marker). */
export const SYSTEM_CONTENT_PREFIXES = [
  'This session is being continued',
  '<ide_',
  '<system-reminder',
  '<available-deferred-tools',
  '<command-name',
] as const
