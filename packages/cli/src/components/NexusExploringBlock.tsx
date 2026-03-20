/**
 * Grouped "Exploring / Explored" block for the MAIN agent's code-exploration tools.
 *
 * While tools are running (same structure as single-agent subagent):
 *   ◎ Exploring  reads:3 · searches:2 · lists:1
 *     ⎿ Read(src/store.ts)
 *            Grep(listSessions)
 *            List(src/)
 *          +40 more tool uses (ctrl+o to expand)
 *          ctrl+b to run in background
 *
 * After completion (2.5s flash):
 *   ✓ Explored · reads:3 · searches:2 · lists:1
 */
import { Box, Text } from 'ink'
import React, { useMemo, useEffect, useState } from 'react'
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
  normalizedMessages: NormalizedMessage[]
  inProgressToolUseIDs: Set<string>
  expandToolDetails?: boolean
  isLoading: boolean
}

function makeLabel(name: string, input: Record<string, unknown>): string {
  return exploreLabelFromRecipientAndParams(name, input)
}

function toolCat(name: string): 'read' | 'search' | 'list' {
  const c = canonToolName(name)
  if (c === 'read' || c === 'readfile') return 'read'
  if (c === 'list' || c === 'listdir' || c === 'listdirectory') return 'list'
  return 'search'
}

function buildCtrs(labels: string[], names: string[]): string {
  let reads = 0, searches = 0, lists = 0
  names.forEach(n => {
    const cat = toolCat(n)
    if (cat === 'read') reads++
    else if (cat === 'search') searches++
    else lists++
  })
  const parts: string[] = []
  if (reads > 0) parts.push(`${reads} file${reads === 1 ? '' : 's'}`)
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  if (lists > 0) parts.push(`${lists} list${lists === 1 ? '' : 's'}`)
  return parts.join(', ')
}

interface ExploreEntry {
  id: string
  label: string
  toolName: string
  done: boolean
}

export function NexusExploringBlock({
  normalizedMessages,
  inProgressToolUseIDs,
  expandToolDetails = false,
  isLoading: _isLoading,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [showExplored, setShowExplored] = useState(false)
  const [exploredCtrs, setExploredCtrs] = useState('')
  const prevHadInProgress = React.useRef(false)

  // Collect exploration tool_use entries from the current turn.
  // In Nexus mode tools appear as ProgressMessages (type='progress') during execution;
  // the AssistantMessage only arrives after assistant_content_complete.
  // So we scan progress messages from the current turn start first, then fall back
  // to the original assistant-message logic for non-Nexus mode.
  const allEntries = useMemo((): ExploreEntry[] => {
    const toolErr = getToolUseResultErrorMap(normalizedMessages)
    // Find the start of the current turn: last user message with text content
    let turnStartIdx = 0
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      const msg = normalizedMessages[i]!
      if (msg.type !== 'user') continue
      const content = (msg as any).message?.content
      if (Array.isArray(content) && content.some((b: any) => b?.type === 'text')) {
        turnStartIdx = i + 1
        break
      }
    }

    // Primary path: scan ProgressMessages from turn start
    const progressEntries: ExploreEntry[] = []
    const seenIds = new Set<string>()
    for (let i = turnStartIdx; i < normalizedMessages.length; i++) {
      const msg = normalizedMessages[i]!
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

    // Fallback: original assistant-message logic (non-Nexus mode)
    const entries: ExploreEntry[] = []
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      const msg = normalizedMessages[i]!
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
  }, [normalizedMessages, inProgressToolUseIDs])

  // Do not gate on isLoading: it can flip false between tool rounds while tools are still unresolved.
  const hasInProgress = allEntries.length > 0 && allEntries.some(e => !e.done)

  useEffect(() => {
    const was = prevHadInProgress.current
    prevHadInProgress.current = hasInProgress
    if (was && !hasInProgress && allEntries.length > 0) {
      setExploredCtrs(buildCtrs(allEntries.map(e => e.label), allEntries.map(e => e.toolName)))
      setShowExplored(true)
    }
  }, [hasInProgress, allEntries])

  // "Explored" flash
  if (!hasInProgress && showExplored) {
    return (
      <Box paddingX={1}>
        <Text color={theme.success ?? 'green'}>✓ Explored</Text>
        {exploredCtrs ? <Text dimColor> {exploredCtrs}.</Text> : null}
      </Box>
    )
  }

  if (!hasInProgress) return null

  const ctrs = buildCtrs(allEntries.map(e => e.label), allEntries.map(e => e.toolName))
  const history = allEntries.map(e => e.label)

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header with counters — same level as single agent ● header */}
      <Box>
        <Text color={theme.primary}>◎ </Text>
        <Text bold>Exploring</Text>
        {ctrs ? <Text dimColor> {ctrs}...</Text> : null}
      </Box>
      {/* Tool history — same section as subagent, same indentation */}
      <ToolHistorySection
        history={history}
        expandToolDetails={expandToolDetails}
        agentId="exploring"
        theme={theme}
      />
    </Box>
  )
}
