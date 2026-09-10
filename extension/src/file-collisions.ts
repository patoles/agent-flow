/**
 * Cross-agent / cross-session file collision detection.
 *
 * Every file-touching tool call is recorded per normalized path in a sliding
 * window. When two distinct parties (session + agent) touch the same file
 * inside the window and at least one of them writes, a collision is reported.
 * Read-vs-read is ignored: agents grepping the same config all day is noise.
 *
 * One shared index per process: the standalone relay tails every session, so
 * this is where cross-session collisions become visible.
 */

import * as path from 'path'

export const COLLISION_WINDOW_MS = 90 * 1000

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface FileTouch {
  sessionId: string
  agent: string
  action: 'read' | 'write'
  /** wall-clock ms of the touch (replay-aware) */
  wall: number
}

export interface FileCollision {
  file: string
  parties: FileTouch[]
}

export function touchAction(toolName: string): 'read' | 'write' {
  return WRITE_TOOLS.has(toolName) ? 'write' : 'read'
}

export class FileCollisionIndex {
  private byFile = new Map<string, FileTouch[]>()

  constructor(private windowMs = COLLISION_WINDOW_MS) {}

  /** Record a touch; returns the collision it completes, if any. */
  touch(file: string, touch: FileTouch): FileCollision | null {
    const key = path.normalize(file)
    const cutoff = touch.wall - this.windowMs
    const recent = (this.byFile.get(key) || []).filter(t => t.wall >= cutoff)
    // Keep one entry per party (latest wins) so the list stays tiny
    const kept = recent.filter(t => !(t.sessionId === touch.sessionId && t.agent === touch.agent))
    kept.push(touch)
    this.byFile.set(key, kept)

    if (kept.length < 2 || !kept.some(t => t.action === 'write')) return null
    return { file: key, parties: kept.slice() }
  }

  /** Drop stale files so the map does not grow with every path ever seen */
  prune(now: number): void {
    const cutoff = now - this.windowMs
    for (const [file, touches] of this.byFile) {
      if (!touches.some(t => t.wall >= cutoff)) this.byFile.delete(file)
    }
  }
}

/** Process-wide index shared by every watcher/parser */
export const fileCollisions = new FileCollisionIndex()
