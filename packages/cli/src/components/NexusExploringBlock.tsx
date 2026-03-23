/**
 * One explore *wave* in the chat timeline (inserted by REPL via buildChatTimeline).
 * Same rhythm as assistant rows: marginTop + ●/✓ in a 2-col gutter, then title + ⎿ history.
 * Counters: Read → Grep → Glob → List → Search (non-zero only), scoped to this segment only.
 */
import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { getTheme } from '../utils/theme.js'
import { ToolHistorySection } from './NexusSubagentBlock.js'
import type { NormalizedMessage } from '../utils/messages.js'
import { getToolUseResultErrorMap } from '../utils/messages.js'
import {
  canonToolName,
  exploreLabelFromRecipientAndParams,
  getParallelToolUsesFromInput,
  isExploreToolName,
  parallelInputIsPureExplore,
} from '../utils/exploreTools.js'

type Props = {
  /** Messages that belong to this explore wave only (chronological slice). */
  segmentMessages: NormalizedMessage[]
  /** Full chat (for tool_result error flags). */
  errorLookupMessages: NormalizedMessage[]
  inProgressToolUseIDs: Set<string>
  expandToolDetails?: boolean
  /**
   * When this wave follows SpawnAgent / subagent Parallel, show mode(task) instead of
   * generic "Exploring" / "Explored".
   */
  segmentTitles?: { exploring: string; explored: string }
  /**
   * From timeline: true only after a non-explore action has completed (or assistant text /
   * new user message). While false, keep ● Exploring even if all tools in this segment
   * already returned (host still thinking or a non-explore tool is in flight).
   */
  waveFinalized: boolean
  /**
   * `host_explore` — main agent code discovery (Exploring/Explored + read/search counts).
   * `subagent_child` — tools run inside SpawnAgent: show Mode(task) only, no “Explored”.
   */
  variant?: 'host_explore' | 'subagent_child'
}

type ExploreBucket = 'read' | 'grep' | 'glob' | 'list' | 'codebase'

function toolNameToExploreBucket(name: string): ExploreBucket | null {
  const c = canonToolName(name)
  if (c === 'read' || c === 'readfile') return 'read'
  if (c === 'grep' || c === 'grepsearch') return 'grep'
  if (c === 'glob' || c === 'filesearch' || c === 'globfilesearch') return 'glob'
  if (c === 'list' || c === 'listdir' || c === 'listdirectory') return 'list'
  if (c === 'codebasesearch') return 'codebase'
  return null
}

/** Header line: "2 reads, 3 searches, 1 list" (grep/glob/codebase → searches). */
function buildExploreHeaderSummary(toolNames: string[]): string {
  const counts: Record<ExploreBucket, number> = {
    read: 0,
    grep: 0,
    glob: 0,
    list: 0,
    codebase: 0,
  }
  for (const n of toolNames) {
    const b = toolNameToExploreBucket(n)
    if (b) counts[b]++
  }
  const searches = counts.grep + counts.glob + counts.codebase
  const parts: string[] = []
  if (counts.read > 0) {
    parts.push(`${counts.read} read${counts.read === 1 ? '' : 's'}`)
  }
  if (searches > 0) {
    parts.push(`${searches} search${searches === 1 ? '' : 'es'}`)
  }
  if (counts.list > 0) {
    parts.push(`${counts.list} list${counts.list === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

function makeLabel(name: string, input: Record<string, unknown>): string {
  return exploreLabelFromRecipientAndParams(name, input)
}

interface ExploreEntry {
  id: string
  label: string
  toolName: string
  done: boolean
}

export function NexusExploringBlock({
  segmentMessages,
  errorLookupMessages,
  inProgressToolUseIDs,
  expandToolDetails = false,
  segmentTitles,
  waveFinalized,
  variant = 'host_explore',
}: Props): React.ReactNode {
  const theme = getTheme()
  const isSubagentChild = variant === 'subagent_child'
  const titleExploring = segmentTitles?.exploring ?? (isSubagentChild ? 'Subagent' : 'Exploring')
  const titleExplored = segmentTitles?.explored ?? (isSubagentChild ? 'Subagent' : 'Explored')

  // Progress-first within this segment, then last assistant explore blocks (non-Nexus fallback).
  const allEntries = useMemo((): ExploreEntry[] => {
    const toolErr = getToolUseResultErrorMap(errorLookupMessages)
    const progressEntries: ExploreEntry[] = []
    const seenIds = new Set<string>()
    for (const msg of segmentMessages) {
      if (msg.type !== 'progress') continue
      const pm = msg as any
      const blocks = pm.content?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue
        const input =
          typeof block.input === 'object' && block.input != null
            ? (block.input as Record<string, unknown>)
            : {}
        if (canonToolName(block.name) === 'parallel') {
          if (!parallelInputIsPureExplore(input)) continue
          const uses = getParallelToolUsesFromInput(input)
          const parallelDone = !inProgressToolUseIDs.has(block.id)
          const parallelFailed = toolErr[block.id] === true
          uses.forEach((u, idx) => {
            if (typeof u.recipient_name !== 'string') return
            const sid = `${block.id}#${idx}`
            if (seenIds.has(sid)) return
            seenIds.add(sid)
            const params =
              typeof u.parameters === 'object' && u.parameters != null
                ? (u.parameters as Record<string, unknown>)
                : {}
            const base = exploreLabelFromRecipientAndParams(
              u.recipient_name,
              params,
            )
            progressEntries.push({
              id: sid,
              label: parallelFailed ? `Attempt ${base}` : base,
              toolName: u.recipient_name,
              done: parallelDone,
            })
          })
          continue
        }
        if (!isExploreToolName(block.name)) continue
        if (seenIds.has(block.id)) continue
        seenIds.add(block.id)
        const baseLabel = makeLabel(block.name, input)
        progressEntries.push({
          id: block.id,
          label: toolErr[block.id] === true ? `Attempt ${baseLabel}` : baseLabel,
          toolName: block.name,
          done: !inProgressToolUseIDs.has(block.id),
        })
      }
    }
    if (progressEntries.length > 0) return progressEntries

    const entries: ExploreEntry[] = []
    for (let i = segmentMessages.length - 1; i >= 0; i--) {
      const msg = segmentMessages[i]!
      if (msg.type !== 'assistant') continue
      const blocks = msg.message.content
      let addedAny = false
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue
        const input =
          typeof block.input === 'object' && block.input != null
            ? (block.input as Record<string, unknown>)
            : {}
        if (canonToolName(block.name) === 'parallel') {
          if (!parallelInputIsPureExplore(input)) continue
          const uses = getParallelToolUsesFromInput(input)
          const parallelDone = !inProgressToolUseIDs.has(block.id)
          const parallelFailed = toolErr[block.id] === true
          for (let ui = uses.length - 1; ui >= 0; ui--) {
            const u = uses[ui]!
            if (typeof u.recipient_name !== 'string') continue
            const params =
              typeof u.parameters === 'object' && u.parameters != null
                ? (u.parameters as Record<string, unknown>)
                : {}
            const base = exploreLabelFromRecipientAndParams(
              u.recipient_name,
              params,
            )
            entries.unshift({
              id: `${block.id}#${ui}`,
              label: parallelFailed ? `Attempt ${base}` : base,
              toolName: u.recipient_name,
              done: parallelDone,
            })
            addedAny = true
          }
          continue
        }
        if (!isExploreToolName(block.name)) continue
        const fbBase = makeLabel(block.name, input)
        entries.unshift({
          id: block.id,
          label: toolErr[block.id] === true ? `Attempt ${fbBase}` : fbBase,
          toolName: block.name,
          done: !inProgressToolUseIDs.has(block.id),
        })
        addedAny = true
      }
      if (addedAny) break
    }
    return entries
  }, [segmentMessages, errorLookupMessages, inProgressToolUseIDs])

  const hasInProgress = allEntries.length > 0 && allEntries.some(e => !e.done)
  /** ● until the wave is settled *and* every segment tool has a result. */
  const showExploring = !waveFinalized || hasInProgress

  const history = allEntries.map(e => e.label)
  const headerSummary = buildExploreHeaderSummary(allEntries.map(e => e.toolName))

  if (allEntries.length === 0) return null

  // Settled header (✓) only after waveFinalized; same last-3 + ctrl+o for both states.
  /** Match `AssistantTextMessage` / tool rows: top gap + 2-char bullet column so we don’t sit flush under the previous row. */
  const root = (
    bullet: React.ReactNode,
    titleLine: React.ReactNode,
    agentId: 'explored' | 'exploring',
  ) => (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box flexDirection="row" alignItems="flex-start" width="100%">
        <Box minWidth={2}>{bullet}</Box>
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" flexWrap="wrap">
            {titleLine}
          </Box>
          <ToolHistorySection
            history={history}
            expandToolDetails={expandToolDetails}
            agentId={agentId}
            theme={theme}
          />
        </Box>
      </Box>
    </Box>
  )

  if (!showExploring) {
    return root(
      <Text color={theme.success}>✓</Text>,
      <>
        <Text bold>{titleExplored}</Text>
        {!isSubagentChild && !expandToolDetails && headerSummary ? (
          <Text dimColor>
            {' '}
            {headerSummary}
          </Text>
        ) : null}
      </>,
      'explored',
    )
  }

  return root(
    <Text color={theme.primary}>●</Text>,
    <>
      <Text bold>{titleExploring}</Text>
      {!isSubagentChild && headerSummary ? (
        <Text dimColor>
          {' '}
          {headerSummary}
        </Text>
      ) : null}
    </>,
    'exploring',
  )
}
