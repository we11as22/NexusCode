import { Box, Text } from 'ink'
import React from 'react'
import { Tool } from '../../Tool.js'
import { Cost } from '../Cost.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { getTheme } from '../../utils/theme.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { ThinkTool } from '../../tools/ThinkTool/ThinkTool.js'
import { getGenericToolForCoreName } from '../../tools/GenericCoreTool.js'
import type { SubAgentState } from '../../nexus-subagents.js'
import { subagentStatusLine, truncateTask } from '../../nexus-subagents.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import type { NormalizedMessage } from '../../utils/messages.js'
import { getDiffStatsForToolUseId } from '../../utils/messages.js'
import type { ToolUseBlockParam } from '../../provider/message-schema.js'

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase()
}

type Props = {
  param: ToolUseBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  verbose: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  /** Whether tool details (inputs/results) are expanded. */
  expandToolDetails?: boolean
  /** Subagents for SpawnAgent; shown under the tool line. */
  subagents?: SubAgentState[]
  /** Full transcript (for matching tool_result diffStats to this tool_use). */
  messages?: NormalizedMessage[]
}

type ParallelToolUseInput = {
  recipient_name?: unknown
  parameters?: unknown
}

function truncateInline(text: string, max = 84): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') return value
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value)
  }
  return ''
}

function canonicalToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeRecipientName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ['functions.', 'function.', 'multi_tool_use.', 'tools.', 'tool.']
  const prefix = prefixes.find((item) => lower.startsWith(item))
  return prefix ? trimmed.slice(prefix.length) : trimmed
}

function toDisplayToolName(rawRecipientName: string): string {
  const normalized = normalizeRecipientName(rawRecipientName)
  const canonical = canonicalToolName(normalized)
  switch (canonical) {
    case 'read':
    case 'readfile':
    case 'readfiletool':
    case 'read_file':
      return 'Read'
    case 'grep':
    case 'grepsearch':
      return 'Grep'
    case 'glob':
    case 'globfilesearch':
    case 'filesearch':
      return 'Glob'
    case 'list':
    case 'listdir':
    case 'listdirectory':
      return 'List'
    case 'codebasesearch':
      return 'CodebaseSearch'
    case 'websearch':
      return 'WebSearch'
    case 'webfetch':
      return 'WebFetch'
    default:
      return normalized
  }
}

function getParallelToolUses(input: Record<string, unknown>): ParallelToolUseInput[] {
  if (!Array.isArray(input.tool_uses)) return []
  return input.tool_uses.filter(
    (item): item is ParallelToolUseInput =>
      typeof item === 'object' && item !== null,
  )
}

function summarizeParallelInput(input: Record<string, unknown>): string | null {
  const uses = getParallelToolUses(input)
  if (uses.length === 0) return null
  const displayNames = uses
    .map((use) => (typeof use.recipient_name === 'string' ? toDisplayToolName(use.recipient_name) : ''))
    .filter(Boolean)
  if (displayNames.length === 0) return `Run ${uses.length} tools`
  const uniqueNames = [...new Set(displayNames)]
  if (uniqueNames.length === 1) {
    const only = uniqueNames[0]
    if (only === 'Read') return `Read ${uses.length} ${uses.length === 1 ? 'file' : 'files'}`
    if (only === 'Grep') return `Search ${uses.length} ${uses.length === 1 ? 'pattern' : 'patterns'}`
    if (only === 'Glob') return `Find ${uses.length} ${uses.length === 1 ? 'file set' : 'file sets'}`
    return `${only} ${uses.length} ${uses.length === 1 ? 'call' : 'calls'}`
  }
  return `Run ${uses.length} tools`
}

function renderParallelInput(input: Record<string, unknown>): string | null {
  const uses = getParallelToolUses(input)
  if (uses.length === 0) return null
  return uses
    .map((use, index) => {
      const recipientName = typeof use.recipient_name === 'string' ? use.recipient_name : '(unknown)'
      const parameters =
        use.parameters != null && typeof use.parameters === 'object'
          ? JSON.stringify(use.parameters)
          : String(use.parameters ?? '{}')
      return `${index + 1}. ${recipientName} ${parameters}`
    })
    .join('\n')
}

function summarizeInput(
  toolName: string,
  input: Record<string, unknown>,
  renderedInput: string,
): string {
  if (toolName === 'Parallel' || toolName === 'parallel') {
    return summarizeParallelInput(input) ?? 'Run tools'
  }
  if (toolName === 'batch' || toolName === 'Batch') {
    const reads = Array.isArray(input.reads) ? input.reads.length : 0
    const lists = Array.isArray(input.lists) ? input.lists.length : 0
    const searches = Array.isArray(input.searches) ? input.searches.length : 0
    const replaces = Array.isArray(input.replaces) ? input.replaces.length : 0
    const parts = [
      reads > 0 ? `${reads} read${reads === 1 ? '' : 's'}` : '',
      lists > 0 ? `${lists} list${lists === 1 ? '' : 's'}` : '',
      searches > 0 ? `${searches} search${searches === 1 ? '' : 'es'}` : '',
      replaces > 0 ? `${replaces} replace${replaces === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    return parts.join(', ') || 'batch'
  }
  if (Array.isArray(input.paths)) {
    const count = input.paths.length
    const noun =
      toolName === 'Read' || toolName === 'View' ? 'files' : 'items'
    return `${count} ${noun}`
  }
  const filePath = formatPrimitive(input.file_path ?? input.path)
  if (filePath) return truncateInline(filePath, 56)
  const command = formatPrimitive(input.command)
  if (command) return truncateInline(command, 56)
  if (renderedInput.trim()) return truncateInline(renderedInput)
  const keys = Object.keys(input)
  if (keys.length === 1) return keys[0] ?? ''
  if (keys.length > 1) return `${keys.length} inputs`
  return ''
}

function countLines(text: string): number {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function getEditInputStats(
  toolName: string,
  input: Record<string, unknown>,
): { path: string; added: number; removed: number } | null {
  if (toolName !== 'Edit') return null
  const path = formatPrimitive(input.file_path ?? input.path)
  const blocks = Array.isArray(input.blocks) ? input.blocks : []
  if (!path) return null
  if (blocks.length > 0) {
    let added = 0
    let removed = 0
    for (const b of blocks) {
      if (typeof b !== 'object' || b == null) continue
      const rec = b as Record<string, unknown>
      const oldRaw = formatPrimitive(rec.old_string)
      const newRaw = formatPrimitive(rec.new_string)
      if (!oldRaw && !newRaw) continue
      removed += countLines(oldRaw)
      added += countLines(newRaw)
    }
    return { path, added, removed }
  }
  const oldRaw = formatPrimitive(input.old_string)
  const newRaw = formatPrimitive(input.new_string)
  if (!oldRaw || !newRaw) return null
  return {
    path,
    added: countLines(newRaw),
    removed: countLines(oldRaw),
  }
}

function getWriteInputStats(
  toolName: string,
  input: Record<string, unknown>,
): { path: string; added: number; removed: number } | null {
  if (toolName !== 'Write') return null
  const path = formatPrimitive(input.file_path ?? input.path)
  if (!path) return null
  const content = formatPrimitive(input.content)
  return { path, added: countLines(content), removed: 0 }
}

/** Prefer core diffStats from the tool result when present so +N/-M matches the real patch. */
function getFileChangeLineStats(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  messages: NormalizedMessage[],
): { path: string; added: number; removed: number } | null {
  const resolved = getDiffStatsForToolUseId(messages, toolUseId)
  if (toolName === 'Edit') {
    const base = getEditInputStats('Edit', input)
    if (!base) return null
    if (resolved) {
      return { path: base.path, added: resolved.added, removed: resolved.removed }
    }
    return base
  }
  if (toolName === 'Write') {
    const base = getWriteInputStats('Write', input)
    if (!base) return null
    if (resolved) {
      return { path: base.path, added: resolved.added, removed: resolved.removed }
    }
    return base
  }
  return null
}

function shouldShowExpandHint(
  toolName: string,
  input: Record<string, unknown>,
  renderedInput: string,
): boolean {
  const keys = Object.keys(input)
  if (keys.length === 0) return false
  if (toolName === 'Parallel' || toolName === 'parallel') return getParallelToolUses(input).length > 0
  const firstValue = keys.length === 1 ? input[keys[0]!] : undefined
  if (
    keys.length === 1 &&
    (typeof firstValue === 'string' ||
      typeof firstValue === 'number' ||
      typeof firstValue === 'boolean' ||
      firstValue == null)
  ) {
    return false
  }
  if (Array.isArray(input.paths)) return input.paths.length > 1
  return renderedInput.includes('\n') || renderedInput.length > 120 || keys.length > 2
}

export function AssistantToolUseMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  verbose,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  expandToolDetails = false,
  subagents = [],
  messages = [],
}: Props): React.ReactNode {
  const isNexusToolUse = typeof param.id === 'string' && param.id.startsWith('part_')
  const tool =
    (isNexusToolUse ? undefined : tools.find(_ => _.name === param.name)) ??
    getGenericToolForCoreName(param.name)
  const isQueued =
    !inProgressToolUseIDs.has(param.id) && unresolvedToolUseIDs.has(param.id)
  // Keeping color undefined makes the OS use the default color regardless of appearance
  const color = isQueued ? getTheme().secondaryText : undefined

  // TODO: Avoid this special case
  if (tool === ThinkTool) {
    // params were already validated in query(), so this won't throe
    const { thought } = ThinkTool.inputSchema.parse(param.input)
    return (
      <AssistantThinkingMessage
        param={{ thinking: thought, signature: '', type: 'thinking' }}
        addMargin={addMargin}
      />
    )
  }

  const normalizedToolName =
    param.name === 'SpawnAgents' || param.name === 'SpawnAgentsParallel'
      ? 'SpawnAgent'
      : param.name === 'TaskCreateBatch'
        ? 'TaskCreate'
        : param.name
  const userFacingToolName =
    normalizedToolName === 'SpawnAgent' || normalizedToolName === 'TaskCreate'
      ? 'Task'
      : tool.userFacingName(param.input as never)
  const inputRecord =
    typeof param.input === 'object' && param.input != null
      ? (param.input as Record<string, unknown>)
      : {}
  const hasInput = Object.keys(inputRecord).length > 0
  let renderedInput = ''
  if (hasInput) {
    try {
      if (param.name === 'Parallel' || param.name === 'parallel') {
        renderedInput =
          renderParallelInput(inputRecord) ??
          tool.renderToolUseMessage(param.input as never, { verbose })
      } else {
        renderedInput = tool.renderToolUseMessage(param.input as never, {
          verbose,
        })
      }
    } catch {
      renderedInput = JSON.stringify(param.input)
    }
  }
  const collapsedInput = hasInput
    ? summarizeInput(param.name, inputRecord, renderedInput)
    : ''
  const fileChangeLineStats = getFileChangeLineStats(
    normalizedToolName,
    inputRecord,
    param.id,
    messages,
  )
  let collapsedLine =
    normalizedToolName === 'Parallel' || normalizedToolName === 'parallel'
      ? (collapsedInput || userFacingToolName)
      : [userFacingToolName, collapsedInput].filter(Boolean).join(' ')
  if (erroredToolUseIDs.has(param.id)) {
    collapsedLine = `Attempt ${collapsedLine}`
  }
  const showExpandHint =
    !expandToolDetails &&
    hasInput &&
    !fileChangeLineStats &&
    shouldShowExpandHint(normalizedToolName, inputRecord, renderedInput)
  /** Match other tool rows: space above SpawnAgent* even when progress uses addMargin={false}. */
  const isSpawnFamilyTool =
    param.name === 'TaskCreate' ||
    param.name === 'TaskCreateBatch' ||
    param.name === 'SpawnAgent' ||
    param.name === 'SpawnAgents' ||
    param.name === 'SpawnAgentsParallel' ||
    ((param.name === 'Parallel' || param.name === 'parallel') && subagents.length > 0)
  const mainBlock = (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin || isSpawnFamilyTool ? 1 : 0}
      width="100%"
    >
      <Box>
        <Box
          flexWrap="nowrap"
          minWidth={collapsedLine.length + (shouldShowDot ? 2 : 0)}
        >
          {shouldShowDot &&
            (isQueued ? (
              <Box minWidth={2}>
                <Text color={color}>{BLACK_CIRCLE}</Text>
              </Box>
            ) : (
              <ToolUseLoader
                shouldAnimate={shouldAnimate}
                isUnresolved={unresolvedToolUseIDs.has(param.id)}
                isError={erroredToolUseIDs.has(param.id)}
              />
            ))}
          {fileChangeLineStats ? (
            <Text color={color} bold={!isQueued}>
              {expandToolDetails
                ? `${erroredToolUseIDs.has(param.id) ? 'Attempt ' : ''}${userFacingToolName} ${truncateInline(fileChangeLineStats.path, 56)}`
                : `${userFacingToolName} ${truncateInline(fileChangeLineStats.path, 56)}`}
              {' '}
              <Text color={getTheme().diff.added}>+{fileChangeLineStats.added}</Text>
              {fileChangeLineStats.removed > 0 || normalizedToolName !== 'Write' ? (
                <>
                  {' '}
                  <Text color={getTheme().diff.removed}>-{fileChangeLineStats.removed}</Text>
                </>
              ) : null}
              {showExpandHint ? ' (ctrl+o to expand)' : ''}
            </Text>
          ) : (
            <Text color={color} bold={!isQueued}>
              {expandToolDetails
                ? `${erroredToolUseIDs.has(param.id) ? 'Attempt ' : ''}${userFacingToolName}`
                : collapsedLine}
              {showExpandHint ? ' (ctrl+o to expand)' : ''}
            </Text>
          )}
        </Box>
        {expandToolDetails && !fileChangeLineStats ? (
          <Box flexDirection="column">
            <Box flexWrap="nowrap">
              {hasInput && (
                <Text color={color}>
                  ({renderedInput})
                </Text>
              )}
              <Text color={color}>…</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
    </Box>
  )
  const showSubagents =
    (normalizedToolName === 'SpawnAgent' ||
      normalizedToolName === 'TaskCreate' ||
      normalizedToolName === 'Parallel' ||
      normalizedToolName === 'parallel') &&
    subagents.length > 0
  if (!showSubagents) return mainBlock

  const running = subagents.filter((sa) => sa.status === 'running')
  const completed = subagents.filter((sa) => sa.status === 'completed' || sa.status === 'error')
  const allDone = running.length === 0 && completed.length > 0

  const orderedSubagents = [...subagents].sort((a, b) => a.startedAt - b.startedAt)
  const multiAgentsLabel = orderedSubagents.every(
    (sa) => String(sa.mode).toLowerCase() === 'explore',
  )
    ? 'explore agents'
    : 'agents'

  // Multiple subagents while at least one is still running: keep **total** count in the header
  // (not running.length) so we never show "Running 1 agent…" when 2 were spawned and one finished.
  // Always show Ask(task) + ⎿ tool/Done per row so a completed agent does not look "gone".
  if (subagents.length > 1 && running.length > 0) {
    const theme = getTheme()
    const nTotal = orderedSubagents.length
    return (
      <Box flexDirection="column" width="100%">
        {mainBlock}
        <Box
          flexDirection="row"
          alignItems="flex-start"
          marginTop={1}
          width="100%"
        >
          <Box minWidth={2}>
            <Text color={theme.primary}>●</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" flexWrap="wrap">
              <Text bold>
                Running {nTotal} {multiAgentsLabel}…
              </Text>
              {!expandToolDetails ? (
                <Text dimColor> (ctrl+o to expand)</Text>
              ) : null}
            </Box>
            {orderedSubagents.map((sa, idx) => {
              const isLast = idx === orderedSubagents.length - 1
              const prefix = isLast ? '└─' : '├─'
              const contPrefix = isLast ? '   ' : '│  '
              const doneOrErr =
                sa.status === 'completed' || sa.status === 'error'
              const tailLine = doneOrErr
                ? null
                : sa.toolHistory.length > 0
                  ? sa.toolHistory[sa.toolHistory.length - 1]!
                  : subagentStatusLine(sa)
              const isErr = sa.status === 'error'
              return (
                <Box key={sa.id} flexDirection="column">
                  <Box flexDirection="row" flexWrap="wrap">
                    <Text dimColor>{prefix}</Text>
                    <Text>
                      {modeLabel(sa.mode)}({truncateTask(sa.task, 48)})
                    </Text>
                  </Box>
                  <Box flexDirection="row" flexWrap="wrap">
                    <Text dimColor>{contPrefix}</Text>
                    <Text color={theme.secondaryText}>⎿ </Text>
                    {doneOrErr ? (
                      <Text dimColor>
                        {isErr ? (sa.error ?? 'Failed') : 'Done'}
                      </Text>
                    ) : (
                      <Text>{tailLine}</Text>
                    )}
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    )
  }

  // All finished, multiple — same tree as in-flight (Ask + ⎿ Done), header "N agents finished"
  if (allDone && completed.length > 1) {
    const theme = getTheme()
    const finishedOrdered = [...completed].sort((a, b) => a.startedAt - b.startedAt)
    return (
      <Box flexDirection="column" width="100%">
        {mainBlock}
        <Box
          flexDirection="row"
          alignItems="flex-start"
          marginTop={1}
          width="100%"
        >
          <Box minWidth={2}>
            <Text color={theme.success ?? 'green'}>●</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" flexWrap="wrap">
              <Text bold>{finishedOrdered.length} agents finished</Text>
              {!expandToolDetails ? (
                <Text dimColor> (ctrl+o to expand)</Text>
              ) : null}
            </Box>
            {finishedOrdered.map((sa, idx) => {
              const isLast = idx === finishedOrdered.length - 1
              const prefix = isLast ? '└─' : '├─'
              const contPrefix = isLast ? '   ' : '│  '
              const isErr = sa.status === 'error'
              return (
                <Box key={sa.id} flexDirection="column">
                  <Box flexDirection="row" flexWrap="wrap">
                    <Text dimColor>{prefix}</Text>
                    <Text>
                      {modeLabel(sa.mode)}({truncateTask(sa.task, 48)})
                    </Text>
                  </Box>
                  <Box flexDirection="row" flexWrap="wrap">
                    <Text dimColor>{contPrefix}</Text>
                    <Text color={theme.secondaryText}>⎿ </Text>
                    <Text dimColor>
                      {isErr ? (sa.error ?? 'Failed') : 'Done'}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    )
  }

  // Single running / single finished / one primary
  const primary =
    running[0] ??
    [...subagents].sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!primary) return mainBlock
  const lastToolLine =
    primary.toolHistory.length > 0
      ? primary.toolHistory[primary.toolHistory.length - 1]!
      : subagentStatusLine(primary)
  const subDone =
    primary.status === 'completed' || primary.status === 'error'
  const theme = getTheme()
  return (
    <Box flexDirection="column" width="100%">
      {mainBlock}
      <Box
        flexDirection="row"
        alignItems="flex-start"
        marginTop={1}
        width="100%"
      >
        {/* Same 2-col gutter as Exploring / parallel multi — aligns with tool ● column */}
        <Box minWidth={2} />
        <Box flexDirection="column" flexGrow={1}>
          <Text color={color}>
            {modeLabel(primary.mode)}({truncateTask(primary.task, 72)})
          </Text>
          {subDone ? (
            <Box flexDirection="row" flexWrap="wrap">
              <Text color={theme.secondaryText}>  ⎿ </Text>
              <Text dimColor>
                {primary.status === 'error'
                  ? (primary.error ?? 'Failed')
                  : 'Done'}
              </Text>
            </Box>
          ) : (
            <Text color={theme.secondaryText}>  ⎿ {lastToolLine}</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}
