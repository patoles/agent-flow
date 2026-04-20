/**
 * Agent Flow — standalone web app for visualizing AI agent orchestration.
 *
 * Starts a local server that:
 *   1. Receives events from agent hooks
 *   2. Watches JSONL transcript files for active sessions
 *   3. Serves the visualizer UI and streams events via SSE
 *   4. Opens the browser automatically
 *
 * Usage: npx @agent-flow/app [--port <number>] [--no-open]
 */
import { parseArgs } from './args'
import { ensureSetup } from '../../scripts/setup'
import { startServer } from './server'

const args = parseArgs(process.argv.slice(2))

console.log('Agent Flow\n')

// Ensure hooks are configured
ensureSetup()

// Start the server
startServer({
  port: args.port,
  openBrowser: args.open,
  workspace: process.env.AGENT_FLOW_WORKSPACE ?? process.cwd(),
  verbose: args.verbose,
})
