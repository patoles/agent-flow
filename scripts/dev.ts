#!/usr/bin/env node
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

export function resolveDevWorkspace(args: string[], cwd = process.cwd()): string {
  const targetArgs = args[0] === '--' ? args.slice(1) : args

  if (targetArgs.length > 1) {
    throw new Error('Expected zero or one directory argument.')
  }

  const workspace = path.resolve(cwd, targetArgs[0] ?? '.')
  let stat: fs.Stats
  try {
    stat = fs.statSync(workspace)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Target directory does not exist: ${workspace}`)
    }
    throw error
  }

  if (!stat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${workspace}`)
  }

  return workspace
}

export function createDevCommands(workspace: string) {
  return {
    relay: 'pnpm run dev:relay',
    web: 'pnpm run dev:web',
    env: { AGENT_FLOW_WORKSPACE: workspace },
  }
}

export function launchDev(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  spawnProcess: typeof spawn = spawn,
) {
  const target = args[0] === '--' ? args[1] : args[0]
  const invocationCwd = target && !path.isAbsolute(target)
    ? env.INIT_CWD || process.cwd()
    : process.cwd()
  const workspace = resolveDevWorkspace(args, invocationCwd)
  const commands = createDevCommands(workspace)
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  return spawnProcess(pnpm, [
    'exec', 'concurrently',
    '-n', 'relay,web',
    '-c', 'blue,green',
    commands.relay,
    commands.web,
  ], {
    env: {
      ...env,
      ...commands.env,
      NEXT_PUBLIC_DEMO: '0',
      NEXT_PUBLIC_RELAY_PORT: '3001',
    },
    stdio: 'inherit',
  })
}

function main() {
  const runner = launchDev(process.argv.slice(2))

  runner.on('error', (error) => {
    console.error('Failed to start development services:', error.message)
    process.exit(1)
  })
  runner.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
