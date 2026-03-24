# Changelog

## 0.5.0

- Feature: Agentic proxy for GitHub Copilot Chat — type `@agent-flow` followed by any prompt to visualize tool calls, messages, and model reasoning in real-time on the canvas
- Feature: Clickable timeline panel — click anywhere on the execution timeline to seek/scrub to that point in the session
- Enhancement: Message bubbles now persist 3x longer (30s hold, 3s fade-out) for easier reading
- Added `.github/copilot-instructions.md` with project guidelines for AI agent productivity
- Added `.vscode/launch.json` and `tasks.json` for Extension Development Host debugging
- Chat participant is now sticky — follow-up messages stay in `@agent-flow` context

## 0.4.7

- Fix: reset button in review mode no longer breaks the extension
  - Active agents are preserved across reset; only completed state and visual history are cleared
  - Event log is trimmed to retain agent_spawn events so review mode seeking works correctly

## 0.4.6

- Updated README: clarified automatic hook configuration behavior
- Updated description and tagline

## 0.4.5

- Initial public release
- Real-time visualization of Claude Code agent execution flows
- Auto-detection of Claude Code sessions via transcript watching
- Claude Code hooks integration for live event streaming
- Multi-session support with session tabs
- Interactive canvas with agent nodes, tool calls, and particles
- Timeline, file attention, and transcript panels
- JSONL event log file watching
