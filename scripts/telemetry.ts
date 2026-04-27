import * as fs from 'fs'
import * as path from 'path'
import { getOrCreateInstallId } from './telemetry/install-id'
import { sanitizeString } from './telemetry/sanitize'
import { syncOnce } from './telemetry/sync'

/**
 * Hardcoded telemetry endpoint + publishable key.
 *
 * These ship inside every published binary. No env var override, no runtime
 * fallback. All enabled installs send events to Agent Flow's Supabase project.
 * Forks that republish under a different name must edit these constants and
 * rebuild.
 *
 * Safe to commit: publishable keys are designed to be public. Postgres RLS
 * denies the anon role everything; the only write path is the telemetry-ingest
 * edge function, which runs under the secret key and validates every event.
 */
export const TELEMETRY_ENDPOINT = 'https://dxwtgqdkyunfhbywqmrz.supabase.co'
export const TELEMETRY_PUBLISHABLE_KEY = 'sb_publishable_AgJ_DIUH9zm8E0yHC9KsRw_WsIv4qc8'

/**
 * Progressive sync schedule. After init(), fire syncs at these offsets:
 *   - 2s (captures session_start that the relay emits right after init)
 *   - +2min
 *   - +3min
 *   - then every 5min
 *
 * Short sessions get flushed quickly; long sessions settle into steady cadence.
 */
const FIRST_SYNC_DELAY_MS = 2 * 1000
const SYNC_SCHEDULE_MS = [2 * 60 * 1000, 3 * 60 * 1000]
const SYNC_REPEAT_MS = 5 * 60 * 1000

const FALSY_VALUES = new Set(['false', '0', 'disabled', ''])

export interface TelemetryEvent {
  event_type: 'session_start' | 'session_end' | 'error'
  session_id: string
  agent_flow_version: string
  os: string
  arch: string
  source?: string
  duration_s?: number
  event_count?: number
  error_class?: string
  /** Comma-separated distinct model IDs observed during the session
   *  (e.g., `"claude-opus-4-7,gpt-5"`). session_end only. */
  models?: string
  /** Which runtimes were being watched: `"claude"`, `"codex"`, or `"claude,codex"`.
   *  session_end only. */
  runtimes?: string
}

export interface TelemetryClientOptions {
  /** Directory for events.jsonl and .cursor. Usually `~/.agent-flow/telemetry`. */
  logDir: string
  /** Path to the stable install UUID. Usually `~/.agent-flow/installation-id`. */
  installIdPath: string
  /** Override for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override the endpoint for tests. Defaults to the hardcoded constant. */
  endpoint?: string
  /** Override the key for tests. Defaults to the hardcoded constant. */
  apiKey?: string
}

export interface TelemetryClient {
  /** Resolve install ID and start the sync timer when telemetry is enabled. */
  init(): Promise<void>
  /** Append an event to the JSONL log. No-op when disabled. */
  emit(event: TelemetryEvent): void
  /** Current enabled state. Re-evaluated from env on every call. */
  isEnabled(): boolean
  /** Stop the sync timer and do a final flush. */
  dispose(): Promise<void>
}

/**
 * Pure function: given an env record, return true if telemetry should emit.
 *
 * Rules:
 * - `DO_NOT_TRACK` truthy → disabled (wins over everything)
 * - `AGENT_FLOW_TELEMETRY` falsy (`false`, `0`, `disabled`, ``) → disabled
 * - Otherwise enabled (including when AGENT_FLOW_TELEMETRY is unset)
 */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  const dnt = env.DO_NOT_TRACK
  if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt.toLowerCase() !== 'false') {
    return false
  }
  const flag = env.AGENT_FLOW_TELEMETRY
  if (flag !== undefined && FALSY_VALUES.has(flag.toLowerCase())) {
    return false
  }
  return true
}

export function createTelemetryClient(opts: TelemetryClientOptions): TelemetryClient {
  const logDir = opts.logDir
  const jsonlPath = path.join(logDir, 'events.jsonl')
  const cursorPath = path.join(logDir, '.cursor')
  const endpoint = opts.endpoint ?? TELEMETRY_ENDPOINT
  const apiKey = opts.apiKey ?? TELEMETRY_PUBLISHABLE_KEY
  const getEnv = () => opts.env ?? process.env

  let installId = ''
  let syncTimer: NodeJS.Timeout | null = null
  let disposed = false
  /** Promise for the currently-running sync, or null if idle. Prevents two
   *  syncOnce calls from racing on the cursor file — the scheduled sync and
   *  dispose's final sync used to both read cursor=N before either advanced
   *  it, POSTing overlapping batches and double-inserting. */
  let syncInFlight: Promise<unknown> | null = null

  function enabled(): boolean {
    return isTelemetryEnabled(getEnv())
  }

  function serialize(event: TelemetryEvent): string {
    return JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      event_type: event.event_type,
      installation_id: installId,
      session_id: sanitizeString(event.session_id),
      agent_flow_version: sanitizeString(event.agent_flow_version),
      os: sanitizeString(event.os, 16),
      arch: sanitizeString(event.arch, 16),
      source: sanitizeString(event.source ?? 'npx', 32),
      duration_s: event.duration_s ?? null,
      event_count: event.event_count ?? null,
      error_class: event.error_class ? sanitizeString(event.error_class, 64) : null,
      models: event.models ? sanitizeString(event.models, 128) : null,
      runtimes: event.runtimes ? sanitizeString(event.runtimes, 32) : null,
    })
  }

  function append(event: TelemetryEvent) {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(jsonlPath, serialize(event) + '\n', { mode: 0o600 })
  }

  function fireSync() {
    if (syncInFlight) return // another sync is already running — skip, not queue
    syncInFlight = syncOnce({ jsonlPath, cursorPath, endpoint, apiKey })
      .catch(() => {
        // Swallow — next tick retries from the same cursor position.
      })
      .finally(() => { syncInFlight = null })
  }

  function scheduleNext(idx: number) {
    const delay = idx < SYNC_SCHEDULE_MS.length ? SYNC_SCHEDULE_MS[idx] : SYNC_REPEAT_MS
    syncTimer = setTimeout(() => {
      fireSync()
      scheduleNext(idx + 1)
    }, delay)
    syncTimer.unref?.()
  }

  function startSync() {
    if (syncTimer) return
    // First sync on a short delay so the relay can write session_start first.
    syncTimer = setTimeout(() => {
      fireSync()
      scheduleNext(0)
    }, FIRST_SYNC_DELAY_MS)
    syncTimer.unref?.()
  }

  function stopSync() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
  }

  return {
    async init() {
      // When disabled, write nothing to disk — no install-id, no telemetry/ dir.
      if (!enabled()) return
      installId = getOrCreateInstallId(opts.installIdPath)
      startSync()
    },

    emit(event: TelemetryEvent) {
      if (!enabled()) return
      // Lazy install-id init in case env toggled between init() and emit().
      if (!installId) installId = getOrCreateInstallId(opts.installIdPath)
      append(event)
    },

    isEnabled() {
      return enabled()
    },

    async dispose() {
      if (disposed) return
      disposed = true
      stopSync()
      // Wait for any in-flight scheduled sync to finish so our final flush
      // starts from an up-to-date cursor.
      if (syncInFlight) { try { await syncInFlight } catch { /* best effort */ } }
      if (enabled()) {
        try { await syncOnce({ jsonlPath, cursorPath, endpoint, apiKey }) } catch { /* best effort */ }
      }
    },
  }
}
