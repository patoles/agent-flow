import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { HOOK_TIMEOUT_S } from './constants'
import {
  getHookCommand, ensureHookScript,
  addWorkspaceToManifest,
} from './discovery'
import {
  readSettingsFile, writeJsonAtomic,
  mergeAgentFlowHooks, hasAgentFlowHook, migrateLegacyHttpHooks,
} from './hook-entries'
import { createLogger } from './logger'

const log = createLogger('Hooks')

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

/** Read and parse Claude Code's global settings.json. Returns null on failure. */
function readGlobalSettings(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(GLOBAL_SETTINGS_PATH)) { return null }
    return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'))
  } catch (err) {
    log.debug('Failed to read Claude settings:', err)
    return null
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

function hooksAlreadyConfigured(): boolean {
  if (hasAgentFlowHooks(GLOBAL_SETTINGS_PATH)) { return true }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    const projectPath = path.join(workspaceFolder, '.claude', 'settings.local.json')
    if (hasAgentFlowHooks(projectPath)) {
      // Backfill manifest for workspaces configured before the manifest existed
      addWorkspaceToManifest(workspaceFolder)
      return true
    }
  }

  return false
}

function hasAgentFlowHooks(settingsPath: string): boolean {
  const result = readSettingsFile(settingsPath)
  if (!result.ok) {
    log.debug('Failed to read hooks settings:', result.error)
    return false
  }
  return hasAgentFlowHook(result.settings)
}

// ─── Configure ────────────────────────────────────────────────────────────────

const HOOK_EVENTS = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
] as const

export async function configureClaudeHooks(): Promise<void> {
  ensureHookScript()

  const hookCommand = getHookCommand()
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const result = readSettingsFile(GLOBAL_SETTINGS_PATH)
  if (!result.ok) {
    // Never overwrite a settings file we couldn't parse: it holds the user's
    // permissions, env and other tools' hooks.
    log.error(`Not configuring hooks, could not parse ${GLOBAL_SETTINGS_PATH}:`, result.error)
    vscode.window.showErrorMessage(
      `Agent Flow could not read ${GLOBAL_SETTINGS_PATH} (${result.error}). Fix the file and run "Agent Flow: Configure Claude Code Hooks" again.`,
    )
    return
  }

  writeJsonAtomic(GLOBAL_SETTINGS_PATH, mergeAgentFlowHooks(result.settings, hookEntry, HOOK_EVENTS))

  vscode.window.showInformationMessage(
    'Claude Code hooks configured. New sessions will stream events to Agent Flow.',
  )
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Replace legacy Agent Flow HTTP hooks with command hooks. Called once on activation.
 *  Caller must call ensureHookScript() first. */
export function migrateHttpHooks(): void {
  const pathsToCheck: string[] = [GLOBAL_SETTINGS_PATH]
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    pathsToCheck.push(path.join(workspaceFolder, '.claude', 'settings.local.json'))
  }

  const hookCommand = getHookCommand()

  for (const settingsPath of pathsToCheck) {
    const result = readSettingsFile(settingsPath)
    if (!result.ok) {
      log.debug(`Skipping hook migration for ${settingsPath}:`, result.error)
      continue
    }
    try {
      if (!migrateLegacyHttpHooks(result.settings, hookCommand, HOOK_TIMEOUT_S)) { continue }
      writeJsonAtomic(settingsPath, result.settings)
      log.info(`Migrated HTTP hooks → command hooks in ${settingsPath}`)
      // Ensure migrated project-level hooks are tracked in the manifest
      if (workspaceFolder && settingsPath.includes(workspaceFolder)) {
        addWorkspaceToManifest(workspaceFolder)
      }
    } catch (err) {
      log.error(`Failed to migrate ${settingsPath}:`, err)
    }
  }
}

// ─── Claude Code Environment ─────────────────────────────────────────────────

/** Check whether CLAUDE_CODE_DISABLE_1M_CONTEXT is set (via env or Claude Code settings). */
export function isDisable1MContext(): boolean {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') { return true }
  const settings = readGlobalSettings()
  return (settings?.env as Record<string, unknown>)?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

export async function promptHookSetupIfNeeded(_context: vscode.ExtensionContext): Promise<void> {
  if (hooksAlreadyConfigured()) { return }
  await configureClaudeHooks()
}
