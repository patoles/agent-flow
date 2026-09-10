import type { SessionInfo } from './bridge-types'

/** Last path segment of a cwd, tolerant of trailing separators and Windows paths */
export function folderName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

/** Label shown for a session: custom name wins, then optional folder prefix, then the raw label */
export function sessionDisplayLabel(session: SessionInfo, customName: string | undefined, showFolder: boolean): string {
  if (customName) return customName
  return showFolder && session.cwd ? `${folderName(session.cwd)} · ${session.label}` : session.label
}

/** Whether tabs need a folder prefix: always standalone, in VS Code only when sessions span several cwds */
export function shouldShowFolder(sessions: SessionInfo[], isVSCode: boolean): boolean {
  return !isVSCode || new Set(sessions.map(s => s.cwd).filter(Boolean)).size > 1
}
