# Setup Findings & Issue Resolution

## Problem Identified

Agent Flow extension was not receiving events from Claude Code sessions because **hooks were not configured in `~/.claude/settings.json`**.

### Root Cause

The extension has two event sources:
1. **Claude Code Hooks** (HTTP POST) — Primary, real-time
2. **SessionWatcher** (JSONL file monitoring) — Fallback, 1-second polling

Without hooks configured, only the fallback mechanism was working, requiring users to manually point to JSONL files or wait for auto-detection to kick in.

## Setup Process

The `pnpm run setup` command now:
1. Detects Claude Code installation
2. Configures hooks in `~/.claude/settings.json` for all event types:
   - `SessionStart`, `SessionEnd`, `Stop`
   - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
   - `SubagentStart`, `SubagentStop`
   - `Notification`
3. Creates hook script at `~/.claude/agent-flow/hook.js`
4. Sets 2-second hook timeout

## Hook Configuration Structure

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/homebrew/bin/node /Users/matias.diaz/.claude/agent-flow/hook.js",
            "timeout": 2
          }
        ]
      }
    ],
    // ... same pattern for all event types
  }
}
```

## Why Two Event Sources?

### SessionWatcher (JSONL monitoring)
- **Pros**: No network overhead, works without setup, detects all sessions automatically
- **Cons**: File system dependent, 1-second polling latency, only recent sessions (10-minute age threshold)

### HookServer (HTTP hooks)
- **Pros**: Real-time, zero latency, works with running sessions
- **Cons**: Requires setup via `pnpm run setup`, network-based

## Testing Verification

After running `pnpm run setup`:
1. Open Agent Flow in Cursor
2. Run `claude "test command"` in separate terminal
3. Events stream in real-time to the visualization

### Diagnostic Script

Added `pnpm run diagnose` to verify setup:
```bash
pnpm run diagnose
```

Checks:
- Claude directory structure
- Hook configuration in settings.json
- Active sessions in projects directory
- Hook script existence
- Workspace path encoding

## Documentation Added

1. **INICIO_RAPIDO.md** — Spanish quick-start guide
2. **TROUBLESHOOTING.md** — Comprehensive debugging guide
3. **scripts/diagnose.js** — Automated setup verification
4. **SETUP_FINDINGS.md** (this file) — Technical documentation

## Key Insights

1. **Hook timeout (2s)** is crucial — Claude Code waits for hook completion before continuing
2. **SessionWatcher is a safety net** — Captures events even if hooks fail
3. **JSONL file age threshold (10 min)** — Prevents scanning stale sessions
4. **Global session detection** — Extension automatically finds active sessions across all projects

## User Experience Improvement

Before:
- User runs `claude` command
- No events visible in Agent Flow
- User confused, tries manual JSONL connection
- Manual steps required

After:
- User runs `pnpm run setup` (one-time)
- User runs `claude` command
- Events appear instantly in real-time visualization
- Seamless experience

## Next Steps for Maintainers

1. Consider making hook timeout configurable
2. Document why 10-minute session age threshold exists
3. Consider periodic hook health checks
4. Add metrics for hook execution time

## Files Modified

- `extension/src/session-watcher.ts` — No functional changes, cleanup
- `extension/src/hook-server.ts` — No functional changes, cleanup
- `extension/src/extension.ts` — No functional changes, cleanup
- `package.json` — Added `diagnose` script

## Files Added

- `SETUP_FINDINGS.md` (this file)
- `INICIO_RAPIDO.md` (Spanish guide)
- `TROUBLESHOOTING.md` (Debug guide)
- `scripts/diagnose.js` (Setup verification script)
