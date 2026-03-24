# Changelog

## Unreleased

- Add experimental Codex session watching alongside the existing Claude Code workflow
- Add a runtime selector so users can switch between Claude Code and Codex session discovery
- Add Codex rollout parser tests and UI runtime branding updates
- Known limitation: Codex automatic context compaction is not yet visualized correctly

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
