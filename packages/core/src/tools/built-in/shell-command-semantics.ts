export interface ShellCommandInterpretation {
  isError: boolean
  message?: string
}

type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => ShellCommandInterpretation

const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  ...(exitCode !== 0 ? { message: `Command failed with exit code ${exitCode}` } : {}),
})

const COMMAND_SEMANTICS = new Map<string, CommandSemantic>([
  ["grep", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "No matches found" } : {}),
  })],
  ["rg", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "No matches found" } : {}),
  })],
  ["find", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "Some directories were inaccessible" } : {}),
  })],
  ["diff", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "Files differ" } : {}),
  })],
  ["test", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "Condition is false" } : {}),
  })],
  ["[", (exitCode) => ({
    isError: exitCode >= 2,
    ...(exitCode === 1 ? { message: "Condition is false" } : {}),
  })],
])

function splitCommandRough(command: string): string[] {
  return command
    .split(/[|;&\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractBaseCommand(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? ""
  return token.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? ""
}

function heuristicallyExtractBaseCommand(command: string): string {
  const parts = splitCommandRough(command)
  const last = parts[parts.length - 1] ?? command
  return extractBaseCommand(last)
}

export function interpretShellCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ShellCommandInterpretation {
  const base = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(base) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}
