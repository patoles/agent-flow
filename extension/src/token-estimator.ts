/**
 * Shared token estimation utilities.
 * Extracts duplicated logic from session-watcher.ts and hook-server.ts.
 */

import {
  CHARS_PER_TOKEN, MIN_TOKEN_ESTIMATE, FALLBACK_TOKEN_ESTIMATE,
  GREP_TOKEN_MULTIPLIER, DEFAULT_TOKEN_MULTIPLIER,
} from './constants'

/** Estimate tokens from actual content length (~4 chars per token) */
export function estimateTokensFromContent(content: unknown): number {
  if (typeof content === 'string') {
    return Math.max(Math.ceil(content.length / CHARS_PER_TOKEN), MIN_TOKEN_ESTIMATE)
  }
  if (Array.isArray(content)) {
    let total = 0
    for (const item of content) {
      if (typeof item === 'string') { total += item.length }
      else if (item && typeof item === 'object' && 'text' in item) { total += String(item.text || '').length }
    }
    return Math.max(Math.ceil(total / CHARS_PER_TOKEN), MIN_TOKEN_ESTIMATE)
  }
  return FALLBACK_TOKEN_ESTIMATE
}

/** Estimate tokens from a text string (~4 chars per token) */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Estimate token cost of a tool result based on tool type */
export function estimateTokenCost(toolName: string, result: string): number {
  const baseTokens = Math.ceil(result.length / CHARS_PER_TOKEN)
  // Full-content tools — return the whole result
  if (toolName === 'Read' || toolName === 'exec' || toolName === 'Bash') { return baseTokens }
  // Pattern/listing tools — content is partial so discount it
  if (toolName === 'Grep' || toolName === 'Glob') { return Math.ceil(baseTokens * GREP_TOKEN_MULTIPLIER) }
  // Web / memory tools — result is a summary, not full content
  if (['WebFetch', 'web_fetch', 'WebSearch', 'web_search',
       'memory_search', 'memory_store', 'browser'].includes(toolName)) {
    return Math.ceil(baseTokens * DEFAULT_TOKEN_MULTIPLIER)
  }
  return Math.ceil(baseTokens * DEFAULT_TOKEN_MULTIPLIER)
}
