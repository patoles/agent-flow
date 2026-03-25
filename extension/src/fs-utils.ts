import * as fs from 'fs'

/**
 * Read a chunk of bytes from a file at a given offset.
 * Uses try/finally to guarantee the file descriptor is always closed.
 */
export function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read new lines appended to a file since `lastSize` bytes.
 * Returns the new lines and updated file size, or null if no new content.
 * Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(filePath: string, lastSize: number): { lines: string[]; newSize: number } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — reset
    return { lines: [], newSize: 0 }
  }
  if (stat.size <= lastSize) {
    return null
  }

  const newContent = readFileChunk(filePath, lastSize, stat.size - lastSize)
  const lines = newContent.split(/\r?\n/).filter(Boolean)
  return { lines, newSize: stat.size }
}
