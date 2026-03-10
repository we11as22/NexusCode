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
  /** Subagents for SpawnAgents (single or multiple); shown under the tool line. */
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

  const userFacingToolName = tool.userFacingName(param.input as never)
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
  const collapsedLine =
    param.name === 'Parallel' || param.name === 'parallel'
      ? (collapsedInput || userFacingToolName)
      : [userFacingToolName, collapsedInput].filter(Boolean).join(' ')
  const showExpandHint =
    !expandToolDetails &&
    hasInput &&
    shouldShowExpandHint(param.name, inputRecord, renderedInput)
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
            {expandToolDetails ? userFacingToolName : collapsedLine}
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
  const showSubagents = param.name === 'SpawnAgents' && subagents.length > 0
  if (!showSubagents) return mainBlock
  return (
    <Box flexDirection="column" width="100%">
      {mainBlock}
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {subagents.map((sa) => (
          <Box key={sa.id} flexDirection="column" marginBottom={1}>
            <Text color={color}>{truncateTask(sa.task)}</Text>
            <Text color={getTheme().secondaryText}>{subagentStatusLine(sa)}</Text>
            {sa.error && sa.status === 'error' ? (
              <Text color={getTheme().error}>{truncateTask(sa.error, 72)}</Text>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
