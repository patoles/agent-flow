/**
 * Subagent file watching logic extracted from SessionWatcher.
 *
 * Manages per-session subagent JSONL file discovery, tailing, and event emission.
 *
 * When inline progress events are active for a subagent (tracked via
 * session.inlineProgressAgents), the file watcher still tracks file position
 * but skips event emission to avoid duplicates. This allows seamless fallback
 * to file-based watching on reconnection when inline progress is no longer flowing.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentState, WatchedSession, emitSubagentSpawn } from './protocol'
import { SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, generateSubagentFallbackName, resolveSubagentChildName } from './constants'
import { readNewFileLines } from './fs-utils'
import { TranscriptParser } from './transcript-parser'
import { handlePermissionDetection, PermissionDetectionDelegate } from './permission-detection'
import { createLogger } from './logger'

const log = createLogger('SubagentWatcher')

export interface SubagentWatcherDelegate extends PermissionDetectionDelegate {
  getSession(sessionId: string): WatchedSession | undefined
  resetInactivityTimer(sessionId: string): void
}

/**
 * Read the .meta.json sidecar file to resolve the subagent's name.
 * Falls back to generateSubagentFallbackName if the meta file is missing or unreadable.
 *
 * For agents that carry no descriptive name in their meta (e.g. Workflow
 * subagents, whose meta is just `{"agentType":"workflow-subagent"}`), we derive
 * a stable name from the transcript file's own id (agent-<hash>.jsonl) so each
 * one renders as a distinct node instead of colliding on a generic label.
 */
function resolveNameFromMeta(jsonlPath: string, fallbackIndex: number): string {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as Record<string, unknown>
    const name = resolveSubagentChildName(meta)
    if (name && name !== 'subagent') return name
  } catch { /* meta file may not exist for older Claude Code versions */ }
  // Derive a stable id from the filename (e.g. "agent-a0fb14872db487d5b") so
  // workflow subagents that share an undescriptive meta still get unique names.
  const fileId = path.basename(jsonlPath, '.jsonl')
  return generateSubagentFallbackName(fileId, fallbackIndex)
}

/** Recursively collect every *.jsonl transcript under a subagents directory.
 *  Newer Claude Code nests Workflow subagents under
 *  `subagents/workflows/wf_<id>/agent-*.jsonl`, so a flat readdir misses them. */
export function collectSubagentJsonlFiles(dir: string): string[] {
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return found }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectSubagentJsonlFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(full)
    }
  }
  return found
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session || !session.subagentsDir) return

  // Start watching the directory tree once it exists. Try a recursive watch
  // first (supported on Windows/macOS) so nested workflow subagent files are
  // detected promptly; fall back to a flat watch on platforms without recursive
  // support (Linux). Either way the POLL_FALLBACK_MS poll re-scans recursively.
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    const onChange = () => scanSubagentsDir(delegate, parser, sessionId)
    try {
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, { recursive: true }, onChange)
    } catch {
      try {
        session.subagentsDirWatcher = fs.watch(session.subagentsDir, onChange)
      } catch (err) { log.debug('Subagent dir watch failed:', err) }
    }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  try {
    // Recurse — Workflow subagents live under subagents/workflows/wf_<id>/.
    for (const filePath of collectSubagentJsonlFiles(subDir)) {
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return

  // Resolve name from the meta file (deterministic, no queue race)
  const agentName = resolveNameFromMeta(filePath, session.subagentWatchers.size + 1)
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
  }
  session.subagentWatchers.set(filePath, state)

  // Pre-scan existing content for dedup IDs and determine if the subagent
  // is still active (has unmatched tool_use blocks = pending work).
  const pendingToolUseIds = new Set<string>()
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 0) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const raw: unknown = JSON.parse(line.trim())
          const entry = raw as { message?: { content?: Array<{ type: string; id?: string; tool_use_id?: string }> } }
          if (raw && typeof raw === 'object' && entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && block.id) {
                state.seenToolUseIds.add(block.id)
                pendingToolUseIds.add(block.id)
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                pendingToolUseIds.delete(block.tool_use_id)
              }
            }
          }
        } catch { /* skip unparseable subagent transcript lines */ }
      }
      state.fileSize = stat.size
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  // Only emit spawn for subagents that are still active (have pending work)
  // AND haven't already been spawned by the transcript parser.
  const alreadySpawned = session.spawnedSubagents.has(agentName)
  state.spawnEmitted = pendingToolUseIds.size > 0 || alreadySpawned
  if (pendingToolUseIds.size > 0 && !alreadySpawned) {
    session.spawnedSubagents.add(agentName)
    emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, agentName, agentName, sessionId)
  }

  // Watch for new content
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  const result = readNewFileLines(filePath, state.fileSize)
  if (!result) return
  state.fileSize = result.newSize

  // If inline progress events are handling this subagent, skip event emission
  // from the file watcher to avoid duplicates. We still advance fileSize above
  // so that if inline progress stops (e.g. reconnection), we resume from the
  // correct position without re-emitting old events.
  if (session.inlineProgressAgents.has(state.agentName)) {
    // Still keep the session alive — the subagent is working
    delegate.resetInactivityTimer(sessionId)
    return
  }

  // Lazily emit spawn on first new content if not already emitted
  if (!state.spawnEmitted) {
    state.spawnEmitted = true
    if (!session.spawnedSubagents.has(state.agentName)) {
      session.spawnedSubagents.add(state.agentName)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
    }
  }

  for (const line of result.lines) {
    parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }

  // Permission detection for subagent tools
  handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)

  // Keep main session alive while subagents are working
  delegate.resetInactivityTimer(sessionId)
}
