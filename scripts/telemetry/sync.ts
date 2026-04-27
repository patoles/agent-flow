import * as fs from 'fs'

const MAX_BATCH = 100
const MAX_BODY_BYTES = 50 * 1024

export interface SyncOptions {
  jsonlPath: string
  cursorPath: string
  endpoint: string
  apiKey: string
  /** Override for tests. Defaults to global fetch. */
  fetch?: typeof fetch
}

export interface SyncResult {
  sent: number
  reason?: string
}

/**
 * Reads unsent events from `jsonlPath` starting at the line offset in `cursorPath`,
 * POSTs a batch to `${endpoint}/functions/v1/telemetry-ingest`, and advances the
 * cursor only if the response is 2xx AND body contains `inserted > 0`.
 *
 * All errors return a SyncResult with a reason — no throws. The next call picks up
 * where this one left off.
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncResult> {
  const f = opts.fetch ?? fetch
  if (!fs.existsSync(opts.jsonlPath)) return { sent: 0, reason: 'no_events_file' }

  const content = fs.readFileSync(opts.jsonlPath, 'utf-8')
  const allLines = content.split('\n').filter((l) => l.length > 0)
  const totalLines = allLines.length

  let cursor = 0
  if (fs.existsSync(opts.cursorPath)) {
    const n = parseInt(fs.readFileSync(opts.cursorPath, 'utf-8').trim(), 10)
    if (!Number.isNaN(n) && n >= 0 && n <= totalLines) cursor = n
  }
  if (cursor >= totalLines) return { sent: 0, reason: 'cursor_caught_up' }

  // Build batch, respecting MAX_BATCH and MAX_BODY_BYTES
  const batch: unknown[] = []
  let bodyBytes = 2 // opening and closing brackets
  for (let i = cursor; i < totalLines && batch.length < MAX_BATCH; i++) {
    const line = allLines[i]
    if (bodyBytes + line.length + 1 > MAX_BODY_BYTES) break
    try {
      batch.push(JSON.parse(line))
      bodyBytes += line.length + 1
    } catch {
      // Skip malformed lines. They'll be passed over as the cursor advances past them.
    }
  }
  if (batch.length === 0) return { sent: 0, reason: 'empty_batch' }

  let resp: Response
  try {
    resp = await f(`${opts.endpoint}/functions/v1/telemetry-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': opts.apiKey },
      body: JSON.stringify(batch),
    })
  } catch {
    return { sent: 0, reason: 'network_error' }
  }

  if (!resp.ok) return { sent: 0, reason: 'http_error' }

  let body: { inserted?: number } = {}
  try { body = await resp.json() } catch { return { sent: 0, reason: 'bad_response' } }

  if (!body.inserted || body.inserted <= 0) return { sent: 0, reason: 'nothing_inserted' }

  // Advance by the full batch length, not body.inserted. This assumes the
  // ingest edge function is all-or-nothing (either accepts the whole batch or
  // rejects individual events against its schema and silently drops them).
  // If the server ever moves to partial-insertion-with-rejection-offsets, this
  // needs to change to advance by body.inserted or a returned offset list —
  // otherwise events rejected in the middle of a batch would be re-sent on the
  // next run, since cursor doesn't know which ones were dropped.
  const newCursor = cursor + batch.length
  fs.writeFileSync(opts.cursorPath, String(newCursor))
  return { sent: batch.length }
}
