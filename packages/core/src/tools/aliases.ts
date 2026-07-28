/**
 * Provider and legacy tool-name normalization lives here so direct calls,
 * Parallel, and registration apply the same rules.
 */
const BUILTIN_ALIASES: Readonly<Record<string, string>> = {
  readfile: "Read",
  listdir: "List",
  listdirectory: "List",
  listfiles: "List",
  listdefinitions: "ListCodeDefinitions",
  readlints: "ReadLints",
  writefile: "Write",
  writetofile: "Write",
  editfile: "Edit",
  replaceinfile: "Edit",
  applypatch: "ApplyPatch",
  executecommand: "Bash",
  runterminalcmd: "Bash",
  grepsearch: "Grep",
  filesearch: "Glob",
  globfilesearch: "Glob",
  codebasesearch: "CodebaseSearch",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  askfollowupquestion: "AskFollowupQuestion",
  spawnagent: "SpawnAgent",
  spawnagents: "SpawnAgent",
  spawnagentoutput: "SpawnAgentOutput",
  spawnagentstop: "SpawnAgentStop",
  taskcreate: "TaskCreate",
  taskcreatebatch: "TaskCreateBatch",
}

const TOOL_NAMESPACE_PREFIXES = [
  "functions.",
  "function.",
  "multi_tool_use.",
  "tools.",
  "tool.",
] as const

export function stripToolNamespace(name: string): string {
  const trimmed = name.trim()
  const lower = trimmed.toLowerCase()
  const prefix = TOOL_NAMESPACE_PREFIXES.find((candidate) =>
    lower.startsWith(candidate),
  )
  return prefix ? trimmed.slice(prefix.length) : trimmed
}

export function canonicalizeToolName(name: string): string {
  return stripToolNamespace(name).toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Resolve a provider/legacy alias. When an available-name collection is
 * supplied, canonical case/separator drift is resolved against that closed
 * set; arbitrary dynamic tool names otherwise remain unchanged.
 */
export function resolveToolNameAlias(
  name: string,
  availableNames?: Iterable<string>,
): string {
  const stripped = stripToolNamespace(name)
  const canonical = canonicalizeToolName(stripped)
  const alias = BUILTIN_ALIASES[canonical]

  if (!availableNames) return alias ?? stripped

  const names = Array.from(availableNames)
  if (names.includes(stripped)) return stripped
  if (alias && names.includes(alias)) return alias
  return names.find((candidate) => canonicalizeToolName(candidate) === canonical)
    ?? stripped
}
