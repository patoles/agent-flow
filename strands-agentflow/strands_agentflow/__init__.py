"""Agent-Flow visualizer integration for Strands Agents.

Provides a HookProvider that emits agent-flow AgentEvent JSONL, enabling
real-time visualization of Strands agent activity in the agent-flow UI.

Usage:
    from strands import Agent
    from strands_agentflow import AgentFlowHookProvider

    agent = Agent(hooks=[AgentFlowHookProvider()])
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterNodeCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeNodeCallEvent,
    BeforeToolCallEvent,
    MessageAddedEvent,
)


def _agent_flow_dir() -> Path:
    home = os.environ.get("STRANDS_HOME", os.path.join(os.path.expanduser("~"), ".strands"))
    return Path(home) / "agent-flow"


def _summarize_tool_input(tool_input: Any) -> str:
    if tool_input is None:
        return ""
    if isinstance(tool_input, str):
        return tool_input[:80]
    if isinstance(tool_input, dict):
        if "file_path" in tool_input:
            return str(tool_input["file_path"])
        if "command" in tool_input:
            return str(tool_input["command"])[:80]
        if "query" in tool_input:
            return str(tool_input["query"])[:80]
        return json.dumps(tool_input, default=str)[:80]
    return str(tool_input)[:80]


def _summarize_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result[:200]
    if isinstance(result, Exception):
        return str(result)[:200]
    if isinstance(result, dict):
        output = result.get("output", result.get("content", ""))
        if isinstance(output, str):
            return output[:200]
    return str(result)[:200]


def _extract_file_path(tool_name: str, tool_input: Any) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    for key in ("file_path", "path", "filePath", "filename"):
        if key in tool_input:
            return str(tool_input[key])
    return None


@dataclass
class AgentFlowHookProvider(HookProvider):
    """Strands HookProvider that writes agent-flow AgentEvent JSONL.

    Creates a JSONL file at ~/.strands/agent-flow/<session-id>.jsonl and
    appends one event per line as the agent executes. The agent-flow visualizer
    auto-discovers and tails these files.

    Args:
        session_id: Optional session ID. Generated if not provided.
        agent_name: Name for the orchestrator node in the visualizer.
    """

    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_name: str = "orchestrator"
    _start_time: float = field(default=0.0, init=False, repr=False)
    _file_path: Path | None = field(default=None, init=False, repr=False)
    _file: Any = field(default=None, init=False, repr=False)
    _spawned: bool = field(default=False, init=False, repr=False)

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self._on_before_invocation)
        registry.add_callback(AfterInvocationEvent, self._on_after_invocation)
        registry.add_callback(BeforeModelCallEvent, self._on_before_model_call)
        registry.add_callback(AfterModelCallEvent, self._on_after_model_call)
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._on_after_tool_call)
        registry.add_callback(MessageAddedEvent, self._on_message_added)
        registry.add_callback(BeforeNodeCallEvent, self._on_before_node_call)
        registry.add_callback(AfterNodeCallEvent, self._on_after_node_call)

    def _elapsed(self) -> float:
        if self._start_time == 0.0:
            return 0.0
        return time.time() - self._start_time

    def _ensure_file(self) -> None:
        if self._file is not None:
            return
        directory = _agent_flow_dir()
        directory.mkdir(parents=True, exist_ok=True)
        self._file_path = directory / f"{self.session_id}.jsonl"
        self._file = open(self._file_path, "a", encoding="utf-8")

    def _emit(self, event_type: str, payload: dict[str, Any]) -> None:
        self._ensure_file()
        event = {
            "time": round(self._elapsed(), 3),
            "type": event_type,
            "payload": payload,
            "sessionId": self.session_id,
        }
        self._file.write(json.dumps(event, default=str) + "\n")
        self._file.flush()

    def _ensure_spawned(self) -> None:
        if self._spawned:
            return
        self._spawned = True
        self._emit("agent_spawn", {
            "name": self.agent_name,
            "isMain": True,
            "task": "Strands session",
            "runtime": "strands",
            "cwd": os.getcwd(),
        })

    def _on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        self._start_time = time.time()
        self._ensure_spawned()

    def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        self._ensure_spawned()
        self._emit("agent_idle", {"name": self.agent_name})

    def _on_after_invocation(self, event: AfterInvocationEvent) -> None:
        self._emit("agent_complete", {
            "name": self.agent_name,
            "sessionEnd": True,
        })
        if self._file:
            self._file.close()
            self._file = None

    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        self._ensure_spawned()
        tool_use = event.tool_use
        tool_name = tool_use.get("name", "unknown") if isinstance(tool_use, dict) else "unknown"
        tool_input = tool_use.get("input", {}) if isinstance(tool_use, dict) else {}

        args_summary = _summarize_tool_input(tool_input)
        file_path = _extract_file_path(tool_name, tool_input)

        payload: dict[str, Any] = {
            "agent": self.agent_name,
            "tool": tool_name,
            "args": args_summary,
            "preview": f"{tool_name}: {args_summary}"[:60],
        }
        if tool_input and isinstance(tool_input, dict):
            payload["inputData"] = {k: str(v)[:200] for k, v in tool_input.items()}
        if file_path:
            payload["filePath"] = file_path

        self._emit("tool_call_start", payload)

    def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        tool_use = event.tool_use
        tool_name = tool_use.get("name", "unknown") if isinstance(tool_use, dict) else "unknown"

        result = event.result
        is_error = isinstance(result, Exception)
        result_summary = _summarize_result(result)

        payload: dict[str, Any] = {
            "agent": self.agent_name,
            "tool": tool_name,
            "result": result_summary,
            "tokenCost": 0,
        }
        if is_error:
            payload["isError"] = True
            payload["errorMessage"] = result_summary

        file_path = None
        tool_input = tool_use.get("input", {}) if isinstance(tool_use, dict) else {}
        if isinstance(tool_input, dict):
            file_path = _extract_file_path(tool_name, tool_input)

        if file_path:
            payload["discovery"] = {
                "id": f"{tool_name}-{file_path}",
                "type": "file",
                "label": os.path.basename(file_path),
                "content": result_summary[:100],
            }

        self._emit("tool_call_end", payload)

    def _on_after_model_call(self, event: AfterModelCallEvent) -> None:
        self._ensure_spawned()
        stop_data = getattr(event, "stop_data", None) or getattr(event, "stopData", None)
        usage = getattr(stop_data, "usage", None) if stop_data else None

        tokens = 0
        tokens_max = 0
        if usage:
            tokens = getattr(usage, "inputTokens", 0) or getattr(usage, "input_tokens", 0) or 0
            tokens_max = getattr(usage, "totalTokens", 0) or getattr(usage, "total_tokens", 0) or 0

        if tokens > 0:
            self._emit("context_update", {
                "agent": self.agent_name,
                "tokens": tokens,
                "breakdown": {
                    "systemPrompt": 0,
                    "userMessages": 0,
                    "toolResults": 0,
                    "reasoning": 0,
                    "subagentResults": 0,
                },
                **({"tokensMax": tokens_max} if tokens_max > 0 else {}),
                "isAuthoritative": True,
            })

    def _on_message_added(self, event: MessageAddedEvent) -> None:
        self._ensure_spawned()
        message = getattr(event, "message", None)
        if not message:
            return

        role = message.get("role", "") if isinstance(message, dict) else getattr(message, "role", "")
        if role not in ("user", "assistant"):
            return

        content = ""
        raw_content = message.get("content", "") if isinstance(message, dict) else getattr(message, "content", "")
        if isinstance(raw_content, str):
            content = raw_content
        elif isinstance(raw_content, list):
            parts = []
            for block in raw_content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    parts.append(block)
            content = "".join(parts)

        if not content.strip():
            return

        self._emit("message", {
            "agent": self.agent_name,
            "role": role,
            "content": content[:2000],
        })

    def _on_before_node_call(self, event: BeforeNodeCallEvent) -> None:
        self._ensure_spawned()
        node_id = getattr(event, "node_id", None) or getattr(event, "nodeId", "subagent")
        child_name = str(node_id)

        self._emit("subagent_dispatch", {
            "parent": self.agent_name,
            "child": child_name,
            "task": f"Node: {child_name}",
        })
        self._emit("agent_spawn", {
            "name": child_name,
            "parent": self.agent_name,
            "task": f"Node: {child_name}",
        })

    def _on_after_node_call(self, event: AfterNodeCallEvent) -> None:
        node_id = getattr(event, "node_id", None) or getattr(event, "nodeId", "subagent")
        child_name = str(node_id)

        self._emit("subagent_return", {
            "child": child_name,
            "parent": self.agent_name,
            "summary": "completed",
        })
        self._emit("agent_complete", {
            "name": child_name,
        })

    def close(self) -> None:
        """Explicitly close the JSONL file (called automatically on AfterInvocation)."""
        if self._file:
            self._file.close()
            self._file = None

    def __del__(self) -> None:
        self.close()
