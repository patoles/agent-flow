# Agent Flow — Project Guidelines

## Overview

Agent Flow is a VS Code extension that provides real-time visualization of AI agent orchestration (Claude Code, GitHub Copilot). It renders an interactive canvas showing agents, tool calls, subagents, and data flow as they execute.

**Monorepo structure:**

| Directory | Purpose | Language |
|-----------|---------|----------|
| `extension/` | VS Code extension host (event ingestion, hook server, webview host) | TypeScript (Node) |
| `web/` | React frontend (canvas visualization, panels, simulation) | TypeScript (React 19 + Next.js) |

## Build & Test

```bash
# Extension
cd extension
npm run build           # esbuild → dist/extension.js
npm run watch           # watch mode with source maps
npm run lint            # tsc --noEmit type-check

# Web / Webview
cd web
pnpm install
pnpm dev                # Next.js dev server (localhost:3000)
pnpm build:webview      # Vite IIFE bundle → extension/dist/webview/

# Full build (from extension/)
npm run build:all       # webview + extension together
npm run package         # .vsix package for distribution
```

## Architecture

```
Extension Host
├── Hook Server      — TCP listener receives Claude Code hook POSTs
├── Session Watcher  — Tails .jsonl transcript files from Claude Code cache
├── Copilot Watcher  — Intercepts GitHub Copilot Chat tool invocations
├── Chat Participant — @agent-flow commands in Copilot Chat
├── LM Tools         — agentFlow_getSessionStatus for Copilot queries
└── Webview Provider — Hosts React app (production bundle or dev iframe)

Webview (React)
├── Canvas           — HTML5 Canvas with d3-force layout, layered rendering
├── Simulation Hook  — Processes AgentEvents into visual state
├── VSCode Bridge    — postMessage communication with extension
└── UI Panels        — Timeline, chat, transcript, file attention, controls
```

**Data flow:** Event sources → AgentEvent protocol → extension deduplicates → postMessage → webview simulation → canvas render loop.

## Key Conventions

### Extension (`extension/src/`)

- **Logger:** Use `createLogger('ModuleName')` from `logger.ts` — never raw `console.log`.
- **Disposables:** Push all long-lived resources to `context.subscriptions` for cleanup.
- **Event deduplication:** Session watcher lifecycle events take priority over hook server. Hook server always passes through tool/message events from subagents.
- **Hook server responses:** Always return HTTP 200 with empty body — returning JSON causes Claude Code schema parsing issues.
- **No runtime deps:** Extension uses only Node.js built-ins + VS Code API. Keep it that way.
- **Constants:** Timeouts and limits live in `constants.ts`. Don't scatter magic numbers.

### Web (`web/`)

- **Canvas rendering:** All visualization drawn on HTML5 Canvas via modules in `components/agent-visualizer/canvas/`. Each `draw-*.ts` handles one layer.
- **Render cache:** Glow sprites and text measurements are cached in `render-cache.ts`. Use these caches — don't create CanvasGradient per frame.
- **Simulation state:** Managed in `hooks/use-agent-simulation.ts` with event processors split across `hooks/simulation/handle-*.ts`.
- **Colors:** All colors defined in `lib/colors.ts` (holographic sci-fi palette). Reference `COLORS.*` — don't hardcode hex values.
- **Layout constants:** Sizing, timing, animation, and force parameters in `lib/canvas-constants.ts`.
- **Component pattern:** Glass-morphism UI via `glass-card.tsx`. Panels are toggled mutually-exclusive from the main `index.tsx` orchestrator.
- **Bridge:** `lib/vscode-bridge.ts` is a singleton. Use the `use-vscode-bridge` hook in components.
- **Path alias:** `@/*` maps to `web/` root — use it for imports.

### Protocol (`extension/src/protocol.ts`)

Event types flow extension → webview: `agent_spawn`, `agent_complete`, `agent_idle`, `tool_call_start`, `tool_call_end`, `subagent_dispatch`, `subagent_return`, `message`, `context_update`, `model_detected`, `permission_requested`, `error`.

When adding new event types, update both `protocol.ts` (extension) and `agent-types.ts` (web).

## Styling

Dark-only theme. Holographic sci-fi aesthetic with cyan primary (`#66ccff`), amber for tool calls, green for completions, red for errors. All panels use glass-morphism (semi-transparent backgrounds with subtle borders).

## Existing Documentation

- [README.md](../README.md) — Features, getting started, commands, settings, requirements
- [CONTRIBUTING.md](../CONTRIBUTING.md) — CLA, bug reports, PRs, code of conduct
- [extension/README.md](../extension/README.md) — Extension marketplace description
