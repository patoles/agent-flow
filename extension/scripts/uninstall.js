#!/usr/bin/env node
/**
 * vscode:uninstall script — runs when the extension is uninstalled.
 * Removes Agent Flow hooks from ALL known Claude Code settings files,
 * then deletes the entire ~/.claude/agent-flow/ directory.
 *
 * Sources for workspace discovery (checked in order, deduplicated):
 * 1. workspaces.json manifest — persists across crashes/restarts
 * 2. Discovery files ({hash}-{pid}.json) — fallback for older versions
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_COMMAND_MARKER = 'agent-flow/hook.js';
const HOOK_URL_PREFIX = 'http://127.0.0.1:';
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow');
const MANIFEST_PATH = path.join(DISCOVERY_DIR, 'workspaces.json');

// Mirrors claudeConfigDirs() in extension/src/claude-home.ts. Duplicated because
// vscode:uninstall runs this as plain CommonJS, outside the bundled extension.
function claudeSettingsPaths() {
  const expandTilde = (p) => {
    if (p === '~') { return os.homedir(); }
    if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(os.homedir(), p.slice(2)); }
    return p;
  };
  const dirs = (process.env.CLAUDE_CONFIG_DIR || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(expandTilde(entry)));
  const unique = [...new Set(dirs)];
  const roots = unique.length > 0 ? unique : [path.join(os.homedir(), '.claude')];
  return roots.map(dir => path.join(dir, 'settings.json'));
}

// ─── Remove hooks from a settings file ─────────────────────────────────────

function removeHooksFromFile(settingsPath) {
  try {
    if (!fs.existsSync(settingsPath)) { return; }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object') { return; }

    let changed = false;
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) { continue; }
      const filtered = entries.filter(entry => {
        return !entry.hooks?.some(h =>
          h.command?.includes(HOOK_COMMAND_MARKER) ||
          h.url?.startsWith(HOOK_URL_PREFIX),
        );
      });
      if (filtered.length !== entries.length) {
        changed = true;
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
    }

    if (!changed) { return; }

    if (Object.keys(hooks).length === 0) { delete settings.hooks; }

    if (Object.keys(settings).length === 0) {
      fs.unlinkSync(settingsPath);
    } else {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch { /* best effort */ }
}

// ─── Collect all known workspace paths ──────────────────────────────────────

function collectWorkspaces() {
  const workspaces = new Set();

  // Source 1: workspaces.json manifest
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        for (const w of data) { workspaces.add(w); }
      }
    }
  } catch { /* skip */ }

  // Source 2: discovery files (fallback — covers versions before the manifest existed)
  try {
    if (fs.existsSync(DISCOVERY_DIR)) {
      const files = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
      for (const file of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, file), 'utf-8'));
          if (d.workspace) { workspaces.add(d.workspace); }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return workspaces;
}

// ─── Main ───────────────────────────────────────────────────────────────────

// 1. Global settings, one per config dir — leaving any behind orphans a hook
// pointing at a hook.js that step 3 deletes.
for (const settingsPath of claudeSettingsPaths()) {
  removeHooksFromFile(settingsPath);
}

// 2. All known project-level settings
for (const workspace of collectWorkspaces()) {
  removeHooksFromFile(path.join(workspace, '.claude', 'settings.local.json'));
}

// 3. Delete entire agent-flow directory (manifest, discovery files, hook script)
try { fs.rmSync(DISCOVERY_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
