/**
 * Resolution of Claude Code's config directories.
 *
 * Claude Code honours CLAUDE_CONFIG_DIR to relocate ~/.claude. People use it to
 * keep separate accounts on one machine — a work alias on ~/.claude and a
 * personal one on ~/.claude-personal, each with its own transcripts, settings
 * and subscription.
 *
 * Agent Flow is a viewer rather than a client, so it reads the variable as a
 * comma-separated list (the form `ccusage` accepts) and watches every entry.
 * That way one board shows both accounts instead of forcing a choice between
 * them; passing a single directory still works and simply scopes it to one.
 *
 * Deliberately not covered here: Agent Flow's own discovery directory. See the
 * note on DISCOVERY_DIR in discovery.ts for why that one stays pinned.
 */

import * as os from 'os'
import * as path from 'path'

/** Claude Code's config directory name under $HOME when the variable is unset. */
export const DEFAULT_CLAUDE_DIR = '.claude'

/** Shells expand `~` before the process sees it, but values that arrive from a
 *  config file or a quoted assignment do not — expand them ourselves so a
 *  literal `~/.claude-personal` is not treated as a relative directory. */
function expandTilde(p: string): string {
  if (p === '~') { return os.homedir() }
  if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(os.homedir(), p.slice(2)) }
  return p
}

/** Claude Code config roots, in the order CLAUDE_CONFIG_DIR listed them.
 *  Falls back to ~/.claude when the variable is unset or has no usable entry. */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(expandTilde(entry)))

  // Deduplicate so a doubled entry doesn't attach two watchers to one directory
  // and emit every session twice.
  const unique = [...new Set(dirs)]
  return unique.length > 0 ? unique : [path.join(os.homedir(), DEFAULT_CLAUDE_DIR)]
}

/** `projects/` under every config root — where Claude Code writes transcripts. */
export function claudeProjectDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return claudeConfigDirs(env).map(dir => path.join(dir, 'projects'))
}

/** `settings.json` under every config root — where hooks are registered. */
export function claudeSettingsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return claudeConfigDirs(env).map(dir => path.join(dir, 'settings.json'))
}
