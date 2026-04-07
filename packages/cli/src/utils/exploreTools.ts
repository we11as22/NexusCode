/**
 * Shared helpers for "code exploration" tools (read/search/structure/lints/LSP/web discovery)
 * and Parallel batches that contain only those tools.
 */

export const EXPLORE_CANONICAL = new Set([
  'read',
  'readfile',
  'grep',
  'grepsearch',
  'glob',
  'filesearch',
  'globfilesearch',
  'list',
  'listdir',
  'listdirectory',
  'codebasesearch',
  'listcodedefinitions',
  'listdefinitions',
  'readlints',
  'lsp',
  'webfetch',
  'websearch',
])

export function canonToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

export function isExploreToolName(name: string): boolean {
  return EXPLORE_CANONICAL.has(canonToolName(name))
}

/**
 * Auxiliary tools: do not close an explore wave (same segment as Read/Grep/…).
 * Mutating / orchestration “real work” (Write, Bash run, TaskCreate, plan exit, Condense, …) is NOT glue.
 */
const EXPLORE_GLUE_CANONICAL = new Set([
  'todowrite',
  'updatetodolist',
  'spawnagentoutput',
  'spawnagentstop',
  'bashoutput',
  'killbash',
  'enterworktree',
  'exitworktree',
  'toolsearch',
  'taskoutput',
  'tasksnapshot',
  'taskget',
  'tasklist',
  'listmcresources',
  'readmcpresource',
  'mcpauthenticate',
  'memorylist',
  'memoryget',
  'listagentruns',
  'agentrunsnapshot',
])

export function isExploreGlueToolName(name: string): boolean {
  return EXPLORE_GLUE_CANONICAL.has(canonToolName(name))
}

export function normalizeRecipientName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = [
    'functions.',
    'function.',
    'multi_tool_use.',
    'tools.',
    'tool.',
  ]
  const prefix = prefixes.find(item => lower.startsWith(item))
  return prefix ? trimmed.slice(prefix.length) : trimmed
}

/** True if a Parallel inner `recipient_name` resolves to an exploration tool. */
export function isExploreRecipientName(recipient: string): boolean {
  const n = normalizeRecipientName(recipient)
  return isExploreToolName(n)
}

type ParallelInnerUse = {
  recipient_name?: unknown
  parameters?: unknown
}

export function getParallelToolUsesFromInput(
  input: Record<string, unknown>,
): ParallelInnerUse[] {
  if (!Array.isArray(input.tool_uses)) return []
  return input.tool_uses.filter(
    (item): item is ParallelInnerUse =>
      typeof item === 'object' && item !== null,
  )
}

/**
 * Parallel batch is an explore wave when every inner call is explore or explore-glue,
 * and at least one inner is a real explore tool (glue-only Parallel is not a wave).
 */
export function parallelInputIsPureExplore(
  input: Record<string, unknown>,
): boolean {
  const uses = getParallelToolUsesFromInput(input)
  if (uses.length === 0) return false
  let sawExplore = false
  for (const u of uses) {
    if (typeof u.recipient_name !== 'string') return false
    const rec = normalizeRecipientName(u.recipient_name)
    if (isExploreToolName(rec)) {
      sawExplore = true
      continue
    }
    if (isExploreGlueToolName(rec)) continue
    return false
  }
  return sawExplore
}

export function shortArg(v: unknown, max = 50): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/** Display label for one inner Parallel call (matches AssistantToolUseMessage style). */
export function exploreLabelFromRecipientAndParams(
  recipient: string,
  parameters: Record<string, unknown>,
): string {
  const n = normalizeRecipientName(recipient)
  const c = canonToolName(n)
  let type = n || recipient
  if (c === 'read' || c === 'readfile') type = 'Read'
  else if (c === 'grep' || c === 'grepsearch') type = 'Grep'
  else if (
    c === 'glob' ||
    c === 'filesearch' ||
    c === 'globfilesearch'
  )
    type = 'Glob'
  else if (c === 'list' || c === 'listdir' || c === 'listdirectory')
    type = 'List'
  else if (c === 'codebasesearch') type = 'Search'
  else if (c === 'listcodedefinitions' || c === 'listdefinitions') type = 'ListCodeDefinitions'
  else if (c === 'readlints') type = 'ReadLints'
  else if (c === 'lsp') type = 'LSP'
  else if (c === 'webfetch') type = 'WebFetch'
  else if (c === 'websearch') type = 'WebSearch'
  const arg = shortArg(
    parameters.file_path ??
      parameters.path ??
      parameters.filePath ??
      parameters.pattern ??
      parameters.query ??
      parameters.glob ??
      parameters.q,
  )
  return arg ? `${type}(${arg})` : type
}

/** Short line for auxiliary tools inside an explore wave (CLI ⎿ history). */
export function exploreGlueDisplayLabel(
  name: string,
  parameters: Record<string, unknown>,
): string {
  const c = canonToolName(name)
  const s = (k: string) => shortArg(parameters[k], 36)
  if (c === 'todowrite' || c === 'updatetodolist') return 'TodoWrite'
  if (c === 'toolsearch') return 'ToolSearch'
  if (c === 'enterworktree') {
    const p = s('path')
    return p ? `EnterWorktree(${p})` : 'EnterWorktree'
  }
  if (c === 'exitworktree') return 'ExitWorktree'
  if (c === 'bashoutput') return 'BashOutput'
  if (c === 'killbash') return 'KillBash'
  if (c === 'spawnagentoutput') return 'SpawnAgentOutput'
  if (c === 'spawnagentstop') return 'SpawnAgentStop'
  if (c === 'taskoutput') {
    const tid = s('task_id') || s('taskId')
    return tid ? `TaskOutput(${tid})` : 'TaskOutput'
  }
  if (c === 'tasksnapshot') {
    const tid = s('task_id') || s('taskId')
    return tid ? `TaskSnapshot(${tid})` : 'TaskSnapshot'
  }
  if (c === 'taskget') {
    const tid = s('task_id') || s('taskId')
    return tid ? `TaskGet(${tid})` : 'TaskGet'
  }
  if (c === 'tasklist') return 'TaskList'
  if (c === 'listmcresources') return 'ListMcpResources'
  if (c === 'readmcpresource') return 'ReadMcpResource'
  if (c === 'mcpauthenticate') return 'MCPAuthenticate'
  if (c === 'memorylist') return 'MemoryList'
  if (c === 'memoryget') {
    const k = s('key')
    return k ? `MemoryGet(${k})` : 'MemoryGet'
  }
  if (c === 'listagentruns') return 'ListAgentRuns'
  if (c === 'agentrunsnapshot') return 'AgentRunSnapshot'
  return normalizeRecipientName(name) || name
}
