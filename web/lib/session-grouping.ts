/**
 * Derive a project + worktree from a session's working directory, so the UI can
 * group concurrent sessions instead of showing them all on one flat page.
 *
 * Pure string logic — no imports — so it runs unchanged in the browser bundle
 * and under `node --test` (see session-grouping.test.ts). Handles both Windows
 * (`\`) and POSIX (`/`) separators regardless of the host platform.
 */

import type { SessionInfo } from './bridge-types'

export interface ProjectWorktree {
  /** Top-level grouping key (repository / project name). */
  project: string
  /** Sub-group within a project. `null` when the cwd is the project itself
   *  (no worktree layer), e.g. a plain `PROJETS/<name>` checkout. */
  worktree: string | null
}

/** Label used when a session has no usable cwd (Codex without meta, old transcripts). */
export const UNGROUPED_PROJECT = 'Other'

/** Split a path on either separator, dropping empty segments (leading slash,
 *  drive-letter artefacts, trailing slash). */
function segments(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter(Boolean)
}

/**
 * Map a cwd to { project, worktree }.
 *
 * Recognised layouts (case-insensitive on the marker dirs):
 *   - AO worktrees:  …/.ao/data/worktrees/<project>/<worktree>[/…]
 *   - PROJETS:       …/PROJETS/<project>[/…]              → worktree = null
 *   - fallback:      last path segment is the project      → worktree = null
 */
export function deriveProjectWorktree(cwd: string | undefined | null): ProjectWorktree {
  if (!cwd || !cwd.trim()) return { project: UNGROUPED_PROJECT, worktree: null }

  const segs = segments(cwd)
  if (segs.length === 0) return { project: UNGROUPED_PROJECT, worktree: null }

  const lower = segs.map(s => s.toLowerCase())

  // AO worktrees: the segment after "worktrees" is the project, the next is the
  // worktree. `…/.ao/data/worktrees/agent-flow/agent-flow-1` → agent-flow / agent-flow-1
  const wtIdx = lower.lastIndexOf('worktrees')
  if (wtIdx !== -1 && segs[wtIdx + 1]) {
    return {
      project: segs[wtIdx + 1],
      worktree: segs[wtIdx + 2] ?? null,
    }
  }

  // PROJETS/<project> (also tolerate "projects"): project = the segment right
  // after the marker; anything deeper is ignored (no worktree layer).
  const projIdx = Math.max(lower.lastIndexOf('projets'), lower.lastIndexOf('projects'))
  if (projIdx !== -1 && segs[projIdx + 1]) {
    return { project: segs[projIdx + 1], worktree: null }
  }

  // Fallback: use the last segment as the project name.
  return { project: segs[segs.length - 1], worktree: null }
}

export interface WorktreeGroup {
  /** Worktree name, or null for the project-level bucket. */
  worktree: string | null
  sessions: SessionInfo[]
}

export interface ProjectGroup {
  project: string
  /** Session count across all worktrees — handy for headers/badges. */
  count: number
  worktrees: WorktreeGroup[]
}

/**
 * Group a flat session list into project → worktree buckets, ready to render.
 * Ordering is deterministic: the ungrouped "Other" bucket last, everything else
 * alphabetical; within a project, the project-level bucket (worktree=null) first
 * then worktrees alphabetically. Session order within a bucket is preserved.
 */
export function groupSessions(sessions: SessionInfo[]): ProjectGroup[] {
  const projects = new Map<string, Map<string | null, SessionInfo[]>>()

  for (const session of sessions) {
    const { project, worktree } = deriveProjectWorktree(session.cwd)
    let worktrees = projects.get(project)
    if (!worktrees) {
      worktrees = new Map()
      projects.set(project, worktrees)
    }
    const bucket = worktrees.get(worktree)
    if (bucket) bucket.push(session)
    else worktrees.set(worktree, [session])
  }

  const projectNames = [...projects.keys()].sort((a, b) => {
    if (a === UNGROUPED_PROJECT) return 1
    if (b === UNGROUPED_PROJECT) return -1
    return a.localeCompare(b)
  })

  return projectNames.map(project => {
    const worktreeMap = projects.get(project)!
    const worktreeKeys = [...worktreeMap.keys()].sort((a, b) => {
      if (a === null) return -1
      if (b === null) return 1
      return a.localeCompare(b)
    })
    let count = 0
    const worktrees: WorktreeGroup[] = worktreeKeys.map(worktree => {
      const groupSessionsList = worktreeMap.get(worktree)!
      count += groupSessionsList.length
      return { worktree, sessions: groupSessionsList }
    })
    return { project, count, worktrees }
  })
}
