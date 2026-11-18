import { CLAUDE_FAMILIES, CLAUDE_FAMILY_ALTERNATION } from './canvas-constants'

/** Convert a 0–1 alpha value to a two-character hex string (e.g. 0.5 → '80') */
export function alphaHex(alpha: number): string {
  return Math.floor(alpha * 255).toString(16).padStart(2, '0')
}

/** Format a token count for display (e.g. 128500 → '128k') */
export function formatTokens(tokens: number): string {
  return `${Math.floor(tokens / 1000)}k`
}

/** Truncate a file path to the last N segments (e.g. '/a/b/c/d.ts' → 'b/c/d.ts') */
export function truncatePath(path: string, segments = 3): string {
  return path.split('/').slice(-segments).join('/')
}

const PROVIDER_PREFIX = /^[a-z]+\.anthropic\./i
const VERSION_SUFFIX = /-v\d+:\d+$/i
const DATE_STAMP = /-\d{8}(?=$|-)/

const CLAUDE_NEW = new RegExp(`claude-(${CLAUDE_FAMILY_ALTERNATION})-(\\d+)(?:-(\\d+))?`, 'i')
const CLAUDE_LEGACY = new RegExp(`claude-(\\d+)(?:-(\\d+))?-(${CLAUDE_FAMILY_ALTERNATION})`, 'i')
const GPT = /gpt-(\S+?)(?:-\d{4}-\d{2}-\d{2})?$/i

function claudeLabel(family: string, major: string, minor?: string): string {
  const name = family[0].toUpperCase() + family.slice(1).toLowerCase()
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

/** Format a raw model ID for display (e.g. 'claude-opus-4-6-20250514' → 'Opus 4.6'). */
export function formatModelName(model: string): string {
  const base = model
    .replace(PROVIDER_PREFIX, '')
    .replace(VERSION_SUFFIX, '')
    .replace(DATE_STAMP, '')

  const m = base.match(CLAUDE_NEW)
  if (m) return claudeLabel(m[1], m[2], m[3])

  const legacy = base.match(CLAUDE_LEGACY)
  if (legacy) return claudeLabel(legacy[3], legacy[1], legacy[2])

  const gpt = base.match(GPT)
  if (gpt) return `GPT-${gpt[1]}`

  return base
}

/** Node color for a model family (null for unknown/absent models — caller falls back to the state color). */
export function getModelColor(model?: string): string | null {
  if (!model) return null
  const m = model.toLowerCase()
  const fam = CLAUDE_FAMILIES.find(f => m.includes(f.name))
  return fam ? fam.color : null
}
