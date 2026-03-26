import type { SimulationEvent } from './agent-types'

/**
 * Stress-test scenario generator.
 *
 * Generates a large number of agents, tool calls, messages, and subagent
 * interactions to simulate a heavy long-running session for profiling.
 *
 * Use with ?stress query param or by toggling STRESS_TEST in mock-scenario.ts
 */

interface StressConfig {
  /** Number of "waves" of subagent work (default: 8) */
  waves: number
  /** Subagents per wave (default: 6) */
  subagentsPerWave: number
  /** Tool calls per subagent (default: 10) */
  toolCallsPerSubagent: number
  /** Messages per subagent (default: 4) */
  messagesPerSubagent: number
  /** Extra tool calls on orchestrator between waves (default: 3) */
  orchestratorToolCallsPerWave: number
}

const DEFAULT_CONFIG: StressConfig = {
  waves: 8,
  subagentsPerWave: 6,
  toolCallsPerSubagent: 10,
  messagesPerSubagent: 4,
  orchestratorToolCallsPerWave: 3,
}

const TOOL_NAMES = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite']
const FILE_PATHS = [
  'src/services/auth.ts', 'src/services/payment.ts', 'src/routes/api.ts',
  'src/models/user.ts', 'src/utils/crypto.ts', 'src/middleware/cors.ts',
  'src/config/database.ts', 'src/workers/email.ts', 'src/hooks/useAuth.tsx',
  'src/components/Dashboard.tsx', 'src/lib/cache.ts', 'src/routes/webhook.ts',
  'tests/integration/auth.test.ts', 'tests/unit/payment.test.ts',
]
const TASK_DESCRIPTIONS = [
  'Refactor authentication middleware',
  'Analyze database query performance',
  'Research API rate limiting strategies',
  'Implement caching layer',
  'Fix race condition in worker queue',
  'Update payment webhooks',
  'Add CORS configuration',
  'Write integration tests for auth flow',
  'Migrate to new SDK version',
  'Profile memory usage in workers',
  'Investigate slow query in dashboard',
  'Add input validation layer',
]

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]
}

export function generateStressScenario(config: Partial<StressConfig> = {}): SimulationEvent[] {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const events: SimulationEvent[] = []
  let t = 0

  const emit = (type: SimulationEvent['type'], payload: Record<string, unknown>, dt = 0.1) => {
    t += dt
    events.push({ time: t, type, payload })
  }

  // Spawn orchestrator
  emit('agent_spawn', { name: 'orchestrator', isMain: true, task: 'Stress test: multi-wave parallel agent work' })
  emit('message', { agent: 'orchestrator', role: 'user', content: 'Run comprehensive analysis and refactoring across the entire codebase with parallel agents' })
  emit('context_update', { agent: 'orchestrator', tokens: 3000, breakdown: { systemPrompt: 1500, userMessages: 1500, toolResults: 0, reasoning: 0, subagentResults: 0 } })

  let subagentCounter = 0

  for (let wave = 0; wave < cfg.waves; wave++) {
    // Orchestrator thinks and does some work between waves
    emit('message', { agent: 'orchestrator', role: 'thinking', content: `Planning wave ${wave + 1}: dispatching ${cfg.subagentsPerWave} agents for parallel work...` }, 0.5)
    emit('message', { agent: 'orchestrator', content: `Starting wave ${wave + 1} of ${cfg.waves}...` }, 0.3)

    // Orchestrator tool calls between waves
    for (let i = 0; i < cfg.orchestratorToolCallsPerWave; i++) {
      const tool = pick(TOOL_NAMES, wave * 10 + i)
      const file = pick(FILE_PATHS, wave * 10 + i)
      emit('tool_call_start', { agent: 'orchestrator', tool, args: file, inputData: { file_path: file } }, 0.2)
      emit('tool_call_end', { agent: 'orchestrator', tool, result: `Processed ${file} — ${50 + (wave * i * 7) % 200} lines`, tokenCost: 300 + (wave * 100) }, 0.3)
    }

    emit('context_update', {
      agent: 'orchestrator',
      tokens: 3000 + wave * 5000,
      breakdown: {
        systemPrompt: 1500, userMessages: 1500,
        toolResults: 1000 * (wave + 1),
        reasoning: 500 * (wave + 1),
        subagentResults: wave * 3000,
      },
    }, 0.1)

    // Spawn subagents for this wave
    const waveAgents: string[] = []
    for (let s = 0; s < cfg.subagentsPerWave; s++) {
      subagentCounter++
      const name = `agent-w${wave}-s${s}`
      const task = pick(TASK_DESCRIPTIONS, subagentCounter)
      waveAgents.push(name)

      emit('subagent_dispatch', { parent: 'orchestrator', child: name, task }, 0.05)
      emit('agent_spawn', { name, parent: 'orchestrator', task }, 0.05)
      emit('context_update', {
        agent: name,
        tokens: 1800,
        breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: 0, reasoning: 0, subagentResults: 0 },
      }, 0.05)
    }

    // Subagents work in parallel (interleaved events to simulate concurrency)
    for (let toolIdx = 0; toolIdx < cfg.toolCallsPerSubagent; toolIdx++) {
      for (let s = 0; s < cfg.subagentsPerWave; s++) {
        const agentName = waveAgents[s]
        const tool = pick(TOOL_NAMES, subagentCounter * 100 + toolIdx * 10 + s)
        const file = pick(FILE_PATHS, toolIdx * cfg.subagentsPerWave + s)

        emit('tool_call_start', { agent: agentName, tool, args: file, inputData: { file_path: file } }, 0.05)
        emit('tool_call_end', {
          agent: agentName, tool,
          result: `Result from ${file}: ${20 + (toolIdx * s * 3) % 150} matches`,
          tokenCost: 200 + toolIdx * 50,
          ...(toolIdx === 0 && s === 0 ? {
            discovery: { type: 'finding', label: `Wave ${wave} finding`, content: `Important pattern found in ${file}` },
          } : {}),
        }, 0.1)

        // Sprinkle messages
        if (toolIdx % Math.max(1, Math.floor(cfg.toolCallsPerSubagent / cfg.messagesPerSubagent)) === 0) {
          emit('message', { agent: agentName, role: 'thinking', content: `Analyzing ${file} for patterns...` }, 0.05)
        }
        if (toolIdx === Math.floor(cfg.toolCallsPerSubagent / 2)) {
          emit('message', { agent: agentName, content: `Found ${3 + s} relevant patterns so far...` }, 0.05)
        }
      }
    }

    // Context updates for subagents
    for (let s = 0; s < cfg.subagentsPerWave; s++) {
      emit('context_update', {
        agent: waveAgents[s],
        tokens: 1800 + cfg.toolCallsPerSubagent * 300,
        breakdown: {
          systemPrompt: 1400, userMessages: 400,
          toolResults: cfg.toolCallsPerSubagent * 200,
          reasoning: cfg.toolCallsPerSubagent * 100,
          subagentResults: 0,
        },
      }, 0.02)
    }

    // Complete subagents
    for (let s = 0; s < cfg.subagentsPerWave; s++) {
      emit('subagent_return', {
        child: waveAgents[s], parent: 'orchestrator',
        summary: `Completed analysis: found ${3 + s} patterns, modified ${1 + s % 3} files`,
      }, 0.1)
      emit('agent_complete', { name: waveAgents[s] }, 0.05)
    }
  }

  // Final orchestrator completion
  emit('message', { agent: 'orchestrator', content: `All ${cfg.waves} waves complete. ${subagentCounter} agents spawned, comprehensive analysis done.` }, 0.5)
  emit('context_update', {
    agent: 'orchestrator',
    tokens: 80000,
    breakdown: { systemPrompt: 1500, userMessages: 1500, toolResults: 15000, reasoning: 22000, subagentResults: 40000 },
  }, 0.2)
  emit('agent_complete', { name: 'orchestrator' }, 1.0)

  return events
}

/** Pre-built scenarios at various load levels */
export const STRESS_SCENARIOS = {
  /** ~200 events, 12 subagents — light load */
  light: () => generateStressScenario({ waves: 2, subagentsPerWave: 3, toolCallsPerSubagent: 5 }),
  /** ~1500 events, 48 subagents — medium load */
  medium: () => generateStressScenario({ waves: 8, subagentsPerWave: 6, toolCallsPerSubagent: 10 }),
  /** ~4000 events, 120 subagents — heavy load */
  heavy: () => generateStressScenario({ waves: 15, subagentsPerWave: 8, toolCallsPerSubagent: 15, messagesPerSubagent: 6 }),
  /** ~8000+ events, 240 subagents — extreme load (will likely cause the reported lag) */
  extreme: () => generateStressScenario({ waves: 20, subagentsPerWave: 12, toolCallsPerSubagent: 20, messagesPerSubagent: 8, orchestratorToolCallsPerWave: 5 }),
}

export type StressLevel = keyof typeof STRESS_SCENARIOS
