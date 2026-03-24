# Agent Flow

Real-time visualization of coding agent orchestration. Watch your agents think, branch, and coordinate as they work across Claude Code and local Codex sessions. [Demo video here](https://www.youtube.com/watch?v=Ud6eDrFN-TA). 

![Agent Flow visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Why Agent Flow?

Coding agents are powerful, but their execution is a black box — you see the final result, not the journey. Agent Flow makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

## Features

- **Live agent visualization** — Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Auto-detect Claude Code sessions** — Automatically discovers active Claude Code sessions in your workspace and streams events
- **Codex session watching** — Watches local Codex rollout sessions and replays tool, message, and subagent activity
- **Claude Code hooks** — Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Multi-session support** — Track multiple concurrent agent sessions with tabs
- **Interactive canvas** — Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels** — Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support** — Point at any JSONL event log to replay or watch agent activity

## Getting Started

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Pick a runtime with **Agent Flow: Select Agent Runtime**
4. Start a Claude Code or Codex session in your workspace — Agent Flow will auto-detect it

### Claude Code Hooks

Agent Flow automatically configures Claude Code hooks the first time you open the panel. These forward events from Claude Code to Agent Flow for zero-latency streaming.

To manually reconfigure hooks, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

### Codex Integrations

To use Agent Flow with Codex:

1. Run **Agent Flow: Select Agent Runtime**
2. Choose `Codex`
3. If you want to connect manually, run **Agent Flow: Connect to Agent Sessions** and choose `Codex Sessions`
4. Start or resume a Codex session in the same workspace
5. Open Agent Flow — active Codex rollout sessions will be discovered automatically

Agent Flow reads local Codex session rollouts from your `CODEX_HOME` data directory and uses the Codex SQLite state DB for session discovery when available.

Current limitation: Codex automatic context compaction is not yet recognized correctly in the visualization, so the diagram and context/token view can become inaccurate after an auto-compact step.

### JSONL Event Log

You can also point Agent Flow at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Flow will tail the file and visualize events as they arrive

## Commands

| Command                                   | Description                                           |
| ----------------------------------------- | ----------------------------------------------------- |
| `Agent Flow: Open Agent Flow`             | Open the visualizer panel                             |
| `Agent Flow: Open Agent Flow to Side`     | Open in a side editor column                          |
| `Agent Flow: Connect to Agent Sessions`   | Manually connect to Claude or Codex sessions          |
| `Agent Flow: Select Agent Runtime`        | Switch between Claude Code and Codex session watching |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming           |

## Keyboard Shortcut

| Shortcut                                     | Action          |
| -------------------------------------------- | --------------- |
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Flow |

## Settings

| Setting                         | Default    | Description                                   |
| ------------------------------- | ---------- | --------------------------------------------- |
| `agentVisualizer.devServerPort` | `0`        | Development server port (0 = production mode) |
| `agentVisualizer.runtime`       | `"claude"` | Runtime to watch: `claude` or `codex`         |
| `agentVisualizer.eventLogPath`  | `""`       | Path to a JSONL event log file to watch       |
| `agentVisualizer.autoOpen`      | `false`    | Auto-open when an agent session starts        |

## Requirements

- VS Code 1.85 or later
- For Claude auto-detection: Claude Code CLI with active sessions
- For Codex auto-detection: local Codex CLI/Desktop with accessible session rollouts under `CODEX_HOME`

## Author

Created by [Simon Patole](https://github.com/patoles), for [CraftMyGame](https://craftmygame.com).

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
