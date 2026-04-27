const DEFAULT_MAX = 200

/**
 * Strips characters that would break JSON serialization or exceed size caps.
 *
 * Removes: double quotes, backslashes, all control characters (0x00-0x1F + 0x7F).
 * Returns empty string for non-string input.
 * Truncates to `maxLen` (default 200) if longer.
 */
export function sanitizeString(input: unknown, maxLen: number = DEFAULT_MAX): string {
  if (typeof input !== 'string') return ''
  const cleaned = input.replace(/["\\\x00-\x1F\x7F]/g, '')
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}
