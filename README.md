# Agent Flow

Real-time visualization of Claude Code agent orchestration. Watch your agents think, branch, and coordinate as they work. [Demo video here](https://www.youtube.com/watch?v=Ud6eDrFN-TA). 

![Agent Flow visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Why Agent Flow?

I built Agent Flow while developing [CraftMyGame](https://craftmygame.com), a game creation platform driven by AI agents. Debugging agent behavior was painful, so we made it visual. Now we're sharing it.

Claude Code is powerful, but its execution is a black box — you see the final result, not the journey. Agent Flow makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

## Features

- **Live agent visualization**: Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Auto-detect Claude Code sessions**: Automatically discovers active Claude Code sessions in your workspace and streams events
- **Claude Code hooks**: Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Multi-session support**: Track multiple concurrent agent sessions with tabs
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels**: Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity

## Getting Started

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Start a Claude Code session in your workspace — Agent Flow will auto-detect it

### Claude Code Hooks

Agent Flow automatically configures Claude Code hooks the first time you open the panel. These forward events from Claude Code to Agent Flow for zero-latency streaming.

To manually reconfigure hooks, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

### JSONL Event Log

You can also point Agent Flow at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Flow will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Flow: Open Agent Flow` | Open the visualizer panel |
| `Agent Flow: Open Agent Flow to Side` | Open in a side editor column |
| `Agent Flow: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Flow |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Requirements

- VS Code 1.85 or later
- For auto-detection: Claude Code CLI with active sessions

## Author

Created by [Simon Patole](https://github.com/patoles), for [CraftMyGame](https://craftmygame.com).

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.

## OpenClaw / Standalone Mode

You can run Agent Flow as a standalone web app (without VS Code) and connect it to any Claude Code–compatible agent runtime, including [OpenClaw](https://openclaw.dev).

### Architecture

```
Agent runtime (OpenClaw / Claude Code)
        │  HTTP POST :7842
        ▼
  hook-server.mjs  ←── Receives hook events, translates to SimulationEvents
        │  WebSocket :7850
        ▼
  Next.js browser  ←── Renders live graph
```

### Quick Start (OpenClaw)

```bash
# 1. Install dependencies
cd web && npm install

# 2. Start the standalone dev server (Next.js + hook server together)
npm run dev:standalone

# 3. In a separate terminal, run the OpenClaw bridge
node scripts/openclaw-bridge.mjs

# 4. Open http://localhost:3000
```

The bridge watches your active OpenClaw session JSONL and forwards events to the hook server, which streams them live to the browser.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOOK_SERVER_PORT` | `7842` | HTTP port for receiving hook events |
| `HUB_SERVER_PORT` | `7850` | WebSocket port for browser clients |
| `OPENCLAW_SESSION_DIR` | `~/.openclaw/agents/main/sessions` | Directory to watch for JSONL files |
| `REPLAY_HISTORY` | `0` | Set to `1` to replay full session history on start |

### Connecting Claude Code Directly

Add to `~/.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse":  [{ "type": "command", "command": "curl -sf -X POST http://127.0.0.1:7842 -H 'Content-Type: application/json' -d @-" }],
    "PostToolUse": [{ "type": "command", "command": "curl -sf -X POST http://127.0.0.1:7842 -H 'Content-Type: application/json' -d @-" }]
  }
}
```
