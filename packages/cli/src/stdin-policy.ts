const TOP_LEVEL_COMMANDS = new Set([
  "approved-tools",
  "config",
  "context",
  "doctor",
  "error",
  "log",
  "mcp",
  "task",
  "update",
])

const OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--cwd",
  "-m",
  "--model",
  "--temperature",
  "--reasoning-effort",
  "--project",
  "-s",
  "--session",
  "--server",
  "--profile",
  "--mode",
])

/**
 * Prompt stdin belongs only to the agent invocation. Administrative
 * subcommands must remain usable from scripts whose stdin is an open pipe.
 */
export function shouldReadPromptFromStdin(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (OPTIONS_WITH_VALUE.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith("-")) continue
    return !TOP_LEVEL_COMMANDS.has(argument)
  }
  return true
}
