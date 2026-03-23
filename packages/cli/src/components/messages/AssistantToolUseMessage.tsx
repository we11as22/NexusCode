import { Box, Text } from 'ink'
import React from 'react'
import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
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

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase()
}

/** Matches `nexus-subagents` toolLabel lines; same list is shown in NexusExploringBlock on ctrl+o. */
function isExploreStyleHistoryLine(line: string): boolean {
  const s = line.replace(/^Attempt\s+/i, '').trim()
  const head = s.split('(')[0]!.trim().toLowerCase().replace(/[^a-z]/g, '')
  return (
    head === 'read' ||
    head === 'list' ||
    head === 'grep' ||
    head === 'glob' ||
    head === 'search' ||
    head === 'codebasesearch'
  )
}

/** Avoid printing the full ⎿ list under SpawnAgent when Nexus timeline already expands it. */
function shouldSuppressExpandedExploreToolHistory(
  isNexusToolUse: boolean,
  expandToolDetails: boolean,
  history: string[],
): boolean {
  return (
    isNexusToolUse &&
    expandToolDetails &&
    history.length > 0 &&
    history.every(isExploreStyleHistoryLine)
  )
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
    param.name === 'SpawnAgents' || param.name === 'SpawnAgentsParallel' ? 'SpawnAgent' : param.name
  const userFacingToolName =
    normalizedToolName === 'SpawnAgent'
      ? 'SpawnAgent'
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
    shouldShowExpandHint(normalizedToolName, inputRecord, renderedInput)
  const mainBlock = (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
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
          <Text color={color} bold={!isQueued}>
            {expandToolDetails
              ? `${erroredToolUseIDs.has(param.id) ? 'Attempt ' : ''}${userFacingToolName}`
              : collapsedLine}
            {showExpandHint ? ' (ctrl+o to expand)' : ''}
          </Text>
        </Box>
        {expandToolDetails ? (
          <Box flexWrap="nowrap">
            {hasInput && (
              <Text color={color}>
                ({renderedInput})
              </Text>
            )}
            <Text color={color}>…</Text>
          </Box>
        ) : null}
      </Box>
      <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
    </Box>
  )
  const showSubagents =
    (normalizedToolName === 'SpawnAgent' ||
      normalizedToolName === 'Parallel' ||
      normalizedToolName === 'parallel') &&
    subagents.length > 0
  if (!showSubagents) return mainBlock

  const running = subagents.filter((sa) => sa.status === 'running')
  const completed = subagents.filter((sa) => sa.status === 'completed' || sa.status === 'error')
  const allDone = running.length === 0 && completed.length > 0

  const toolCountFor = (sa: SubAgentState) =>
    sa.toolUsesCount > 0 ? sa.toolUsesCount : sa.toolHistory.length

  // Multiple subagents while at least one is still running: list **all** of them so
  // finished ones stay visible (✓ Done) instead of disappearing when running.length drops to 1.
  if (subagents.length > 1 && running.length > 0) {
    const nDone = completed.length
    const nRun = running.length
    const allExploreRunning = running.every(
      (sa) => String(sa.mode).toLowerCase() === 'explore',
    )
    const agentsLabel = allExploreRunning ? 'explore agents' : 'agents'
    const theme = getTheme()
    return (
      <Box flexDirection="column" width="100%">
        {mainBlock}
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Box>
            <Text color={theme.primary}>✽ </Text>
            <Text bold>
              {nDone > 0
                ? `${nRun} running · ${nDone} done`
                : `Running ${nRun} ${agentsLabel}…`}
            </Text>
            {!expandToolDetails ? (
              <Text dimColor> (ctrl+o to expand)</Text>
            ) : null}
          </Box>
          {subagents.map((sa, idx) => {
            const isLast = idx === subagents.length - 1
            const prefix = isLast ? '└─' : '├─'
            const contPrefix = isLast ? '   ' : '│  '
            const nTools = toolCountFor(sa)
            const doneOrErr =
              sa.status === 'completed' || sa.status === 'error'
            if (doneOrErr) {
              const isErr = sa.status === 'error'
              return (
                <React.Fragment key={sa.id}>
                  <Box>
                    <Text dimColor>  {prefix} </Text>
                    <Text color={isErr ? theme.error : theme.success}>
                      {isErr ? '✗ ' : '✓ '}
                    </Text>
                    <Text>
                      {modeLabel(sa.mode)}({truncateTask(sa.task, 48)})
                    </Text>
                    {nTools > 0 ? (
                      <Text dimColor>
                        {' '}
                        · {nTools} tool use{nTools !== 1 ? 's' : ''}
                      </Text>
                    ) : null}
                  </Box>
                  <Box>
                    <Text dimColor>  {contPrefix}</Text>
                    <Text color={theme.primary}>⎿ </Text>
                    <Text dimColor>
                      {isErr ? (sa.error ?? 'Failed') : 'Done'}
                    </Text>
                  </Box>
                </React.Fragment>
              )
            }
            const tailLine =
              sa.toolHistory.length > 0
                ? sa.toolHistory[sa.toolHistory.length - 1]!
                : subagentStatusLine(sa)
            const suppressExploreDup = shouldSuppressExpandedExploreToolHistory(
              isNexusToolUse,
              expandToolDetails,
              sa.toolHistory,
            )
            return (
              <React.Fragment key={sa.id}>
                <Box>
                  <Text dimColor>  {prefix} </Text>
                  <Text>
                    {modeLabel(sa.mode)}({truncateTask(sa.task, 48)})
                  </Text>
                  {nTools > 0 ? (
                    <Text dimColor>
                      {' '}
                      · {nTools} tool use{nTools !== 1 ? 's' : ''}
                    </Text>
                  ) : null}
                </Box>
                {expandToolDetails ? (
                  <Box flexDirection="column">
                    {suppressExploreDup ? (
                      <Box>
                        <Text dimColor>  {contPrefix}</Text>
                        <Text dimColor>
                          ⎿ {sa.toolHistory.length} explore tool use
                          {sa.toolHistory.length === 1 ? '' : 's'} — see
                          exploration block below
                        </Text>
                      </Box>
                    ) : sa.toolHistory.length > 0 ? (
                      <>
                        <Box>
                          <Text dimColor>  {contPrefix}</Text>
                          <Text color={theme.primary}>⎿ </Text>
                          <Text color={theme.secondaryText}>
                            {sa.toolHistory[0]}
                          </Text>
                        </Box>
                        {sa.toolHistory.slice(1).map((entry, hi) => (
                          <Text
                            key={`${sa.id}-h-${hi}`}
                            color={theme.secondaryText}
                          >
                            {'  '}
                            {contPrefix}
                            {'   '}
                            {entry}
                          </Text>
                        ))}
                      </>
                    ) : (
                      <Box>
                        <Text dimColor>  {contPrefix}</Text>
                        <Text color={theme.primary}>⎿ </Text>
                        <Text color={theme.secondaryText}>Starting…</Text>
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Box>
                    <Text dimColor>  {contPrefix}</Text>
                    <Text color={theme.primary}>⎿ </Text>
                    <Text dimColor>{tailLine}</Text>
                  </Box>
                )}
              </React.Fragment>
            )
          })}
          {expandToolDetails ? (
            <Text color={theme.secondaryText}>
              {'     '}ctrl+b to run in background
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  }

  // All finished, multiple — collapsed: one summary line; expanded: tree
  if (allDone && completed.length > 1) {
    const totalTools = completed.reduce((acc, sa) => acc + toolCountFor(sa), 0)
    if (!expandToolDetails) {
      return (
        <Box flexDirection="column" width="100%">
          {mainBlock}
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            <Box>
              <Text color={getTheme().success ?? 'green'}>● </Text>
              <Text bold>{completed.length} agents finished</Text>
              <Text dimColor> (ctrl+o to expand)</Text>
            </Box>
            <Box>
              <Text dimColor>
                {'  ⎿ '}
                {totalTools} tool use{totalTools !== 1 ? 's' : ''}
              </Text>
            </Box>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width="100%">
        {mainBlock}
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Box>
            <Text color={getTheme().success ?? 'green'}>● </Text>
            <Text bold>{completed.length} agents finished</Text>
          </Box>
          {completed.map((sa, idx) => {
            const isLast = idx === completed.length - 1
            const prefix = isLast ? '└─' : '├─'
            const contPrefix = isLast ? '   ' : '│  '
            const isErr = sa.status === 'error'
            const nTools = toolCountFor(sa)
            return (
              <React.Fragment key={sa.id}>
                <Box>
                  <Text dimColor>  {prefix} </Text>
                  <Text>{modeLabel(sa.mode)}({truncateTask(sa.task, 48)})</Text>
                  {nTools > 0 ? (
                    <Text dimColor>
                      {' '}
                      · {nTools} tool use{nTools !== 1 ? 's' : ''}
                    </Text>
                  ) : null}
                </Box>
                <Box>
                  <Text dimColor>  {contPrefix} </Text>
                  <Text color={getTheme().primary}>⎿ </Text>
                  <Text dimColor>
                    {isErr ? (sa.error ?? 'Failed') : 'Done'}
                  </Text>
                </Box>
              </React.Fragment>
            )
          })}
        </Box>
      </Box>
    )
  }

  // Single running / single finished / one primary
  const primary =
    running[0] ??
    [...subagents].sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!primary) return mainBlock
  const suppressExploreDup = shouldSuppressExpandedExploreToolHistory(
    isNexusToolUse,
    expandToolDetails,
    primary.toolHistory,
  )
  const visibleHistory =
    expandToolDetails && !suppressExploreDup
      ? primary.toolHistory
      : primary.toolHistory.slice(0, 3)
  const hiddenUses = Math.max(0, primary.toolHistory.length - visibleHistory.length)
  return (
    <Box flexDirection="column" width="100%">
      {mainBlock}
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        <Text color={color}>
          {modeLabel(primary.mode)}({truncateTask(primary.task, 72)})
        </Text>
        {primary.status === 'completed' || primary.status === 'error' ? (
          <Text dimColor>  ⎿ {primary.status === 'error' ? (primary.error ?? 'Failed') : 'Done'}</Text>
        ) : suppressExploreDup && expandToolDetails ? (
          <>
            <Text dimColor>
              {'  '}⎿{' '}
              {primary.toolHistory.length > 0
                ? `${primary.toolHistory.length} explore tool use${primary.toolHistory.length === 1 ? '' : 's'} — see exploration block below`
                : 'Starting…'}
            </Text>
            <Text color={getTheme().secondaryText}>{'     '}ctrl+b to run in background</Text>
          </>
        ) : (
          <>
            {visibleHistory.length > 0 ? (
              <Text color={getTheme().secondaryText}>  ⎿ {visibleHistory[0]}</Text>
            ) : (
              <Text color={getTheme().secondaryText}>  ⎿ Starting…</Text>
            )}
            {visibleHistory.slice(1).map((entry, idx) => (
              <Text key={`${primary.id}-history-${idx}`} color={getTheme().secondaryText}>
                {'     '}{entry}
              </Text>
            ))}
            {hiddenUses > 0 ? (
              <Text color={getTheme().secondaryText}>
                {'     '}+{hiddenUses} more tool uses (ctrl+o to expand)
              </Text>
            ) : null}
            <Text color={getTheme().secondaryText}>{'     '}ctrl+b to run in background</Text>
          </>
        )}
      </Box>
    </Box>
  )
}
