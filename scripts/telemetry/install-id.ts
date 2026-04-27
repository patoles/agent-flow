import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Reads the installation ID from `filePath`, or generates a fresh UUID v4 and
 * writes it if the file is missing or contains invalid data.
 *
 * The file is chmod 0600 (user read/write only) since it's a stable identifier.
 */
export function getOrCreateInstallId(filePath: string): string {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8').trim()
    if (UUID_REGEX.test(existing)) return existing
  }
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const id = crypto.randomUUID()
  fs.writeFileSync(filePath, id + '\n', { mode: 0o600 })
  return id
}
