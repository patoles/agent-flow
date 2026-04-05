# Agent Flow Troubleshooting Guide

## Problem: Extension doesn't receive events from Claude Code

### Setup Checklist

Two event sources are available. You must configure at least ONE:

#### ✅ Option 1: Claude Code Hooks (Recommended - Real-time)
This is the **primary method** and the most reliable.

**Step 1: Configure hooks (one-time setup)**
```bash
cd /Users/matias.diaz/Documents/code/agent-flow
pnpm run setup
```

This command:
- Detects your Claude Code installation
- Adds hook configuration to your `~/.claude/settings.json`
- Creates the relay script

**Step 2: Verify hook configuration**
```bash
cat ~/.claude/settings.json | grep -A 5 "hooks"
```

You should see something like:
```json
"hooks": {
  "agent-flow": {
    "bin": "node",
    "args": ["~/.claude/agent-flow/hook.js"],
    ...
  }
}
```

**Step 3: Open Agent Flow in Cursor**
- Command Palette → "Agent Flow: Open Agent Flow"
- The panel should show: "Hook server running on port XXXX"

**Step 4: Start a Claude Code session**
- Open a **new terminal** in Cursor
- Run: `claude <your-prompt>`

Events should stream in real-time.

#### ✅ Option 2: JSONL File Watching (Fallback - Near real-time)
Use this if hooks aren't working or for replaying old sessions.

**Method A: Auto-detect active sessions**
- Extension automatically watches `~/.claude/projects/<project>/`
- Only detects sessions modified in last **10 minutes**
- Works automatically when you run `claude` commands

**Method B: Manual JSONL file connection**
```bash
# Find your session file
ls -lht ~/.claude/projects/*/  # shows most recently modified

# Then in Agent Flow:
# - Command Palette → "Agent Flow: Connect to Running Agent"
# - Select "Watch JSONL File"
# - Choose the .jsonl file
```

---

## Common Issues

### Issue 1: "Hook server running on port X but no events arrive"

**Cause**: Hooks configured but Claude Code isn't sending events

**Fix**:
1. Check if hooks are in settings:
   ```bash
   cat ~/.claude/settings.json | grep -A 10 "agent-flow"
   ```

2. Verify the hook script exists:
   ```bash
   ls -la ~/.claude/agent-flow/hook.js
   ```

3. Check extension logs (Cursor Dev Tools):
   - View → Developer Tools
   - Find logs with `[HookServer]` or `[Extension]`

4. Run hook manually to test:
   ```bash
   node ~/.claude/agent-flow/hook.js
   # Should output: Agent Flow hook (nothing means working)
   ```

### Issue 2: "Session not detected" or "No active sessions found"

**Cause**: SessionWatcher only looks for files modified in last 10 minutes

**Fix**:
1. Use Option 2B (Manual JSONL file connection) for old sessions

2. For new sessions: Make sure you're running:
   ```bash
   claude <your-prompt>  # In a separate terminal
   ```
   NOT just in the current shell

3. Check JSONL files exist:
   ```bash
   ls ~/.claude/projects/*/
   ```

4. Look at file timestamps:
   ```bash
   ls -lhtr ~/.claude/projects/*/ | tail -5
   ```

### Issue 3: Hook server keeps restarting or port changes

**Cause**: Multiple VS Code/Cursor windows, or port in use

**Fix**:
```bash
# Kill existing hook servers
pkill -f "agent-flow/hook.js"

# Check what's using the port
lsof -i :3001  # or whatever port is shown
```

### Issue 4: Events stop flowing after a while

**Cause**: fs.watch on macOS can silently stop

**Fix**: 
- Extension has a 3-second poll fallback
- If still stuck, restart the extension (Close → Reopen panel)

---

## How To Debug

### 1. Enable Extension Logs
In Cursor Dev Tools (View → Developer Tools):
```javascript
// Shows all extension output
console.log("[HookServer] ...", "[SessionWatcher] ...")
```

Look for lines like:
- `[HookServer] [Hook] PreToolUse` → Events arriving from hooks
- `[SessionWatcher] Active session found` → JSONL file detected
- `[SessionWatcher] Session age=X` → How old the file is

### 2. Check Hook Delivery
```bash
# In one terminal, watch the hook script
tail -f ~/.claude/agent-flow/hook.log 2>/dev/null || echo "No log yet"

# In another terminal, run a Claude Code session
claude "list files in current directory"
```

You should see hook events in the log.

### 3. Monitor JSONL Files
```bash
# In one terminal, watch for new JSONL files
watch 'ls -lhtr ~/.claude/projects/*/*.jsonl | tail -3'

# In another terminal
claude "something"

# Check the JSONL contents
tail -f ~/.claude/projects/*/*.jsonl
```

---

## Do I Need A New Terminal Every Time?

**YES**, if running `claude` CLI commands. Here's why:

```bash
# Option 1: New terminal (WORKS)
# Terminal A: Run Agent Flow extension
# Terminal B: claude "do something"  ← New separate terminal

# Option 2: Same terminal (DOESN'T WORK)
claude "do something" && echo "doesn't send events to extension"
```

The hook server and JSONL watcher listen for events **outside** the current process.

However, if using the **standalone web app** (`npx agent-flow-app`), you don't need any terminals—the app listens globally for all Claude Code sessions.

---

## Global Session Detection

Agent Flow **automatically** detects Claude Code sessions globally across your machine:

1. Scans `~/.claude/projects/` every 1 second
2. Looks for `.jsonl` files in:
   - Workspace-specific directories
   - Subdirectory projects (e.g., CLI started from `project/src/`)
3. Monitors for sessions active in last 10 minutes

**To monitor older sessions**: Use manual "Watch JSONL File" option.

---

## Setup Once, Use Forever

After running `pnpm run setup`:
- ✅ Hooks automatically configured
- ✅ Hook script persists across Claude Code updates
- ✅ Auto-detects your workspace

You only need to rerun `setup` if:
- Claude Code installation changes
- You want to reconfigure for a different workspace
- Hook script gets corrupted

---

## Still Not Working?

1. Verify workspace path:
   ```bash
   pwd  # in your project folder
   ```

2. Check encoded project dir exists:
   ```bash
   ls ~/.claude/projects/ | grep -i "agent-flow"
   ```

3. Look for error messages in:
   - Cursor Dev Tools console
   - `~/.claude/agent-flow/hook.log` (if it exists)

4. Try the standalone app instead:
   ```bash
   npx agent-flow-app --port 3001
   # Then run: claude "something" in another terminal
   ```

5. File an issue with:
   - Output of: `cat ~/.claude/settings.json | grep -A 20 hooks`
   - Output of: `ls -la ~/.claude/projects/`
   - Extension console logs (View → Developer Tools)
