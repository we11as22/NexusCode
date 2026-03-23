/**
 * Shared helpers for "code exploration" tools (Read, Grep, Glob, List, CodebaseSearch)
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
])

export function canonToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

export function isExploreToolName(name: string): boolean {
  return EXPLORE_CANONICAL.has(canonToolName(name))
}

/** TodoWrite / update_todo_list — may sit between Read/Grep without closing the explore wave. */
const EXPLORE_GLUE_CANONICAL = new Set(['todowrite', 'updatetodolist'])

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

/** Every inner call is a read-only explore tool (Read, Grep, …). */
export function parallelInputIsPureExplore(
  input: Record<string, unknown>,
): boolean {
  const uses = getParallelToolUsesFromInput(input)
  if (uses.length === 0) return false
  return uses.every(
    u =>
      typeof u.recipient_name === 'string' &&
      isExploreRecipientName(u.recipient_name),
  )
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
  const arg = shortArg(
    parameters.file_path ??
      parameters.path ??
      parameters.pattern ??
      parameters.query ??
      parameters.glob,
  )
  return arg ? `${type}(${arg})` : type
}
