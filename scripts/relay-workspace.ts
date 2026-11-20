export function resolveRelayWorkspace(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const targetArgs = args[0] === '--' ? args.slice(1) : args
  return targetArgs[0] ?? env.AGENT_FLOW_WORKSPACE ?? cwd
}
