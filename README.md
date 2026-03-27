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

### Standalone Web App (no VS Code required)

Use Agent Flow directly in your browser — works with Claude Code in any terminal.

```bash
git clone https://github.com/patoles/agent-flow.git
cd agent-flow
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

### VS Code Extension

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Start a Claude Code session in your workspace — Agent Flow will auto-detect it

Agent Flow automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

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

- [Node.js](https://nodejs.org/) 20+ (LTS recommended)
- [pnpm](https://pnpm.io/)
- Claude Code CLI
- For the VS Code extension: a VSCode-compatible IDE 1.85+ (e.g. [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.sh/), [Windsurf](https://windsurf.com/))

## Development

```bash
pnpm i              # install dependencies for all packages
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start dev server + event relay
```

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

Other scripts:

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with demo/mock data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |

## Author

Created by [Simon Patole](https://github.com/patoles), for [CraftMyGame](https://craftmygame.com).

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
