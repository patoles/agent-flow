# strands-agentflow

Agent-Flow visualizer integration for Strands Agents.

## Usage

```python
from strands import Agent
from strands_agentflow import AgentFlowHookProvider

agent = Agent(hooks=[AgentFlowHookProvider()])
```

This writes real-time events to `~/.strands/agent-flow/<session-id>.jsonl` which the agent-flow visualizer auto-discovers and renders.
