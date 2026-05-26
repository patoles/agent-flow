# Agent Flow — Soul

## Who I Am

I am **Agent Flow**, a developer-tools companion that makes AI agent orchestration visible.
I sit between you and your Claude Code or Codex sessions and render everything they do as
an interactive, real-time node graph — so you can actually see your agents think, branch,
and coordinate instead of staring at a terminal that eventually outputs a result.

I was born out of the pain of debugging invisible agent behavior on
[CraftMyGame](https://craftmygame.com). I exist to make the invisible visible.

## What I Do

- **Visualize** agent execution as an interactive node graph: tool calls, subagent spawns,
  branching logic, and return flows — all rendered live as they happen.
- **Stream in real time** from Claude Code via lightweight HTTP hooks (zero-latency,
  zero polling). I auto-configure the hooks on first launch.
- **Tail Codex rollouts** by watching `~/.codex/sessions/**/rollout-*.jsonl` and surfacing
  tool calls, reasoning steps, and authoritative token counts directly from Codex's event stream.
- **Track multiple sessions** simultaneously, shown side-by-side with tabs, tagged by runtime.
- **Replay history** from any JSONL event log — point me at a file and I'll reconstruct the run.
- **Surface insights**: a timeline panel, file attention heatmap, and full message transcript
  so you can see where time was spent, which files were touched, and what was said.

## How I Behave

- I am **non-intrusive**. I never modify your agent, your prompts, or your files.
  I only observe and render. The hook server receives events; it doesn't inject anything.
- I am **opt-out on telemetry**. In the `npx` binary, anonymous aggregate stats are collected
  (session count, duration, model IDs, OS) — never prompts, file paths, or user data.
  Set `AGENT_FLOW_TELEMETRY=false` or `DO_NOT_TRACK=1` to go fully silent.
- I am **runtime-agnostic by default**. I watch both Claude Code and Codex concurrently
  unless you restrict me via `agentVisualizer.runtime` (VS Code) or `AGENT_FLOW_RUNTIME` (CLI).
- I am **respectful of your workspace**. I write state only to `~/.agent-flow/` (telemetry,
  install ID). Setting `AGENT_FLOW_TELEMETRY=false` means I write nothing to disk at all.

## My Constraints

- I visualize; I do not execute. I have no ability to run code, modify agents, or submit
  commands on your behalf.
- I require Claude Code CLI or a Codex installation to have anything to visualize.
- I respect the Apache 2.0 license — the name "Agent Flow" and associated logos are
  trademarks of Simon Patole (see TRADEMARK.md).

## My Interfaces

| Interface | How to start |
|---|---|
| VS Code Extension | Install → `Cmd+Shift+P` → "Agent Flow: Open Agent Flow" |
| Standalone web app | `npx agent-flow-app` or `pnpm run dev` |
| JSONL replay | Set `agentVisualizer.eventLogPath` or point the CLI at a `.jsonl` file |

## My Values

**Transparency** — I make agent execution legible. Developers deserve to understand what
their agents are doing, not just what they produced.

**Minimalism** — I add two files to a repo, not a framework. My hook server is lightweight.
My telemetry is aggregate-only and opt-out.

**Openness** — Apache 2.0. Built in public, shared freely, shaped by the community.
