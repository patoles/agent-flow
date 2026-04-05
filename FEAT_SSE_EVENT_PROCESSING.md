# Feature: Fix SSE Event Processing in Standalone Mode

## Problem Statement

Agent Flow's visualizer failed to display real-time agent events when running in standalone mode (`pnpm run dev`). Events were being transmitted from the relay server to the browser via Server-Sent Events (SSE), but were never visualized on the canvas or processed by the simulation engine.

### Symptoms

- Browser console showed: `[SSE] Connected to relay` ✓
- Browser console showed: `[SSE] Received message: agent-event` ✓
- Browser showed: `WAITING FOR AGENT SESSION` (no agents rendered)
- Events were buffered in sessionEventsRef but never delivered to the simulation

### Root Causes

#### 1. Unreliable PostMessage Pattern
The original code in `use-vscode-bridge.ts` attempted to route SSE messages through `window.postMessage()`:

```typescript
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data)
    window.postMessage(data, '*')  // ❌ Problematic
  } catch {}
}
```

**Why it failed:** In same-origin contexts, `window.postMessage(data, '*')` does not reliably trigger the `window.addEventListener('message', ...)` handler in the VSCodeBridge. The bridge's message handler is designed for cross-origin postMessage (VS Code extension ↔ webview), not self-messaging within the web app.

#### 2. Missing Session Auto-Selection
When SSE events arrived before a session was selected, they were routed to "background activity" instead of being added to `pendingEventsRef`:

```typescript
const selected = selectedSessionIdRef.current  // Always null on first event
if (selected && eventData.event.sessionId === selected && !sessionSwitchPendingRef.current) {
  pendingEventsRef.current.push(simEvent)  // ❌ Never executed
}
```

This prevented the simulation engine from ever receiving events.

---

## Solution Overview

### 1. Direct SSE Event Processing
Process SSE messages directly in the `use-vscode-bridge` hook instead of routing through `postMessage`. This bypasses the unreliable self-messaging pattern.

**Key changes:**
- Parse and route SSE messages directly to event handlers
- Support all five SSE message types:
  - `agent-event` — individual agent events
  - `agent-event-batch` — bulk event replay
  - `session-list` — initial session inventory
  - `session-started` — new session detected
  - `session-ended`/`session-updated` — session lifecycle

### 2. Auto-Select Session on First Event
When the first event arrives and no session is selected, automatically:
1. Select that session
2. Create a session entry if it doesn't exist
3. Mark session switch as pending to prevent race conditions
4. Clear pending events to avoid processing in wrong state

```typescript
if (!selected && eventData.event.sessionId) {
  sessionSwitchPendingRef.current = true
  pendingEventsRef.current.length = 0
  selectedSessionIdRef.current = eventData.event.sessionId
  selected = eventData.event.sessionId
  setSelectedSessionId(eventData.event.sessionId)
  setSessions(prev => {
    const exists = prev.find(s => s.id === eventData.event.sessionId)
    if (exists) return prev
    return [...prev, {
      id: eventData.event.sessionId!,
      label: `Session ${eventData.event.sessionId!.slice(0, 8)}`,
      status: 'active' as const,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
    }]
  })
}
```

### 3. Session Buffering & Multi-Session Support
- Buffer events per session for replay when switching sessions
- Maintain separate event queues to prevent cross-contamination
- Mark "background activity" for sessions not currently selected

---

## Technical Implementation

### Files Modified

#### `web/hooks/use-vscode-bridge.ts`
- **Lines 64-163**: Replaced postMessage relay with direct SSE event handling
- **Lines 84-132**: Added logic for auto-selecting session on first event
- **Lines 134-158**: Added session lifecycle handlers for all five message types
- **Lines 160-195**: Added agent-event-batch handler for efficient bulk replay

### Event Flow (Fixed)

```
Relay Server
    ↓ (SSE stream)
Browser EventSource
    ↓ (es.onmessage)
use-vscode-bridge hook (DIRECT PROCESSING) ← Fixed: no longer uses postMessage
    ↓ (setState + pendingEventsRef)
useAgentSimulation hook
    ↓ (animate loop)
Simulation Engine
    ↓
Canvas Visualization ✓
```

---

## Testing & Validation

### Reproduction Steps (Before Fix)

1. Start relay: `pnpm run dev`
2. Run Claude Code session: `claude code "list files"`
3. Browser shows: "WAITING FOR AGENT SESSION"
4. Browser console shows events received but never processed
5. Canvas remains empty

### Verification Steps (After Fix)

1. Start relay: `pnpm run dev`
2. Run Claude Code session: `claude code "list files"`
3. Browser immediately selects session automatically
4. Canvas renders agent node
5. Agent moves and interacts in real-time
6. Timeline updates with events
7. Console logs confirm event flow: `[SSE] Processing agent-event`

### Edge Cases Handled

- **No session exists initially**: Creates session entry on first event ✓
- **Multiple concurrent sessions**: Each buffered separately; can switch between them ✓
- **Session already selected**: Routes to pending events immediately ✓
- **Event arrives before session lifecycle**: Auto-selects rather than discarding ✓
- **Event batch replay**: Processes all events with proper session buffering ✓

---

## Impact

### Before Fix
- ❌ Standalone mode unusable for real-time visualization
- ❌ Web-based relay server non-functional
- ❌ No visual feedback when Claude Code runs

### After Fix
- ✅ Real-time event visualization in standalone mode
- ✅ Web app relay server fully functional
- ✅ Auto-discovery of sessions
- ✅ Multi-session support with buffering
- ✅ Zero-latency event delivery to simulator

---

## Breaking Changes

**None.** This is a pure bug fix. The API contracts remain unchanged:
- `useVSCodeBridge()` returns the same interface
- `useAgentSimulation()` receives the same event format
- VS Code extension mode (`bridge.isVSCode === true`) unaffected

---

## Performance Considerations

- **Event processing**: Now O(1) per event (direct handler vs. postMessage → message listener)
- **Memory**: No additional memory overhead; reuses existing event buffering
- **Network**: No change; SSE stream is still streamed incrementally
- **CPU**: Slightly lower CPU usage due to elimination of postMessage overhead

---

## Future Improvements

1. **Session list pre-fetch**: Could request `session-list` immediately on SSE connection
2. **Session lifecycle events**: Relay could emit `session-started` before first `agent_spawn` event
3. **Batching optimization**: Group rapid events into batches to reduce re-renders
4. **Connection recovery**: Implement reconnect logic with event replay on disconnect

---

## References

- **Issue**: SSE events not visualized in standalone mode
- **Related**: VS Code bridge uses postMessage for extension ↔ webview but not for self-messaging
- **Standards**: [EventSource API](https://html.spec.whatwg.org/multipage/server-sent-events.html)
