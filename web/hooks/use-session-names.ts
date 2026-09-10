'use client'

import { useCallback, useState } from 'react'

const STORAGE_KEY = 'agent-flow-session-names'

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

/** User-assigned session names, persisted per session id in localStorage. */
export function useSessionNames() {
  const [names, setNames] = useState<Record<string, string>>(load)

  /** Empty name resets the session to its default label */
  const rename = useCallback((id: string, name: string) => {
    setNames(prev => {
      const next = { ...prev }
      if (name.trim()) next[id] = name.trim()
      else delete next[id]
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  return { names, rename }
}
