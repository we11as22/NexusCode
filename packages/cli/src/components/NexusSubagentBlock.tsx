/**
 * Subagent progress block. Layout:
 *
 * 1 agent:
 *   ● Explore(task)
 *     ⎿ Read(file.ts)
 *            Grep(pattern)
 *          +N more tool uses (ctrl+o to expand)
 *
 * After completion (~2.5s flash, same idea as ✓ Explored):
 *   ✓ Explore(task)
 *     ⎿ Done
 *
 * N agents:
 *   Running N subagents…
 *     …
 */
import { Box, Text } from 'ink'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getTheme } from '../utils/theme.js'
import type { SubAgentState } from '../nexus-subagents.js'
import { truncateTask } from '../nexus-subagents.js'

const COMPLETED_SUBAGENT_VISIBLE_MS = 2800

type Props = {
  subagentsByPartId: Record<string, SubAgentState[]>
  isLoading: boolean
  expandToolDetails?: boolean
}

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase()
}

/**
 * Shared tool-history section. Used by both AgentBlock and NexusExploringBlock.
 * Renders at the "current" indent level (caller wraps with extra paddingLeft as needed).
 *
 *   ⎿ Read(file.ts)          ← "  ⎿ " = 2sp + ⎿ + sp
 *          Grep(pattern)     ← "       " = 7sp (aligns with tool text after ⎿)
 *        +N more…            ← "     " = 5sp
 *        (subagents: ctrl+b hint)
 */
export function ToolHistorySection({
  history,
  expandToolDetails,
  agentId,
  theme,
  showBackgroundHint = true,
}: {
  history: string[]
  expandToolDetails: boolean
  agentId: string
  theme: ReturnType<typeof getTheme>
  /** Hide “ctrl+b to run in background” (e.g. host Exploring/Explored block). */
  showBackgroundHint?: boolean
}): React.ReactNode {
  const maxShown = expandToolDetails ? history.length : 3
  const visible = history.slice(-maxShown)
  const hidden = Math.max(0, history.length - maxShown)

  // "  ⎿ " = 2sp + ⎿ + sp = 4 chars → tool name at col 4.
  // All continuation lines must start at col 4 to align vertically.
  return (
    <Box flexDirection="column">
      {visible.length > 0 ? (
        <>
          <Box>
            <Text color={theme.primary}>  ⎿ </Text>
            <Text>{visible[0]}</Text>
          </Box>
          {visible.slice(1).map((line, idx) => (
            <Box key={`${agentId}-h-${idx}`}>
              <Text dimColor>    {line}</Text>
            </Box>
          ))}
        </>
      ) : (
        <Box>
          <Text dimColor>  ⎿ Starting…</Text>
        </Box>
      )}
      {hidden > 0 && (
        <Box>
          <Text dimColor>    +{hidden} more tool uses (ctrl+o to expand)</Text>
        </Box>
      )}
      {showBackgroundHint ? (
        <Box>
          <Text dimColor>    ctrl+b to run in background</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** One agent block: header + tool history. */
function AgentBlock({
  sa,
  expandToolDetails,
  theme,
}: {
  sa: SubAgentState
  expandToolDetails: boolean
  theme: ReturnType<typeof getTheme>
}): React.ReactNode {
  const isCompleted = sa.status === 'completed' || sa.status === 'error'
  const isErr = sa.status === 'error'

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isCompleted ? (isErr ? theme.error : (theme.success ?? 'green')) : theme.primary}>
          {isCompleted ? (isErr ? '✗ ' : '✓ ') : '● '}
        </Text>
        <Text bold>{modeLabel(sa.mode)}({truncateTask(sa.task, 64)})</Text>
      </Box>

      {isCompleted ? (
        <Box>
          <Text dimColor>  ⎿ {isErr ? (sa.error ?? 'Failed') : 'Done'}</Text>
        </Box>
      ) : (
        <ToolHistorySection
          history={sa.toolHistory}
          expandToolDetails={expandToolDetails}
          agentId={sa.id}
          theme={theme}
        />
      )}
    </Box>
  )
}

export function NexusSubagentBlock({
  subagentsByPartId,
  isLoading: _isLoading,
  expandToolDetails = false,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [dismissedCompletedIds, setDismissedCompletedIds] = useState<Set<string>>(() => new Set())
  const dismissTimeoutByIdRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const allSubagents = useMemo(() => {
    return Object.values(subagentsByPartId).flat().sort((a, b) => a.startedAt - b.startedAt)
  }, [subagentsByPartId])

  // New run cleared parent state — reset local dismiss bookkeeping.
  useEffect(() => {
    if (Object.keys(subagentsByPartId).length === 0) {
      for (const t of dismissTimeoutByIdRef.current.values()) clearTimeout(t)
      dismissTimeoutByIdRef.current.clear()
      setDismissedCompletedIds(new Set())
    }
  }, [subagentsByPartId])

  // After completion, keep the ✓ Done line visible for a short time (CLI footer previously hid instantly).
  useEffect(() => {
    for (const sa of allSubagents) {
      if (sa.status !== 'completed' && sa.status !== 'error') continue
      if (dismissedCompletedIds.has(sa.id)) continue
      if (dismissTimeoutByIdRef.current.has(sa.id)) continue
      const id = sa.id
      const start = sa.finishedAt ?? Date.now()
      const delay = Math.max(0, COMPLETED_SUBAGENT_VISIBLE_MS - (Date.now() - start))
      const t = setTimeout(() => {
        dismissTimeoutByIdRef.current.delete(id)
        setDismissedCompletedIds((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }, delay)
      dismissTimeoutByIdRef.current.set(id, t)
    }
  }, [allSubagents, dismissedCompletedIds])

  const visible = allSubagents.filter(
    (sa) =>
      sa.status === 'running' ||
      ((sa.status === 'completed' || sa.status === 'error') && !dismissedCompletedIds.has(sa.id)),
  )

  if (visible.length === 0) return null

  const running = visible.filter((sa) => sa.status === 'running')
  // Multiple *visible* rows (running + recently completed): keep layout/header when only one is still running.
  const isMulti = visible.length > 1

  return (
    <Box flexDirection="column" paddingX={1}>
      {isMulti && running.length > 0 && (
        <Box>
          <Text color={theme.primary}>✽ </Text>
          <Text bold>
            {running.length === visible.length
              ? `Running ${running.length} subagents…`
              : `${running.length} running · ${visible.length - running.length} done`}
          </Text>
        </Box>
      )}

      {visible.map((sa) => (
        <Box key={sa.id} paddingLeft={isMulti ? 2 : 0} flexDirection="column">
          <AgentBlock sa={sa} expandToolDetails={expandToolDetails} theme={theme} />
        </Box>
      ))}

      {!isMulti && running.length === 1 && (
        <Box>
          <Text color={theme.secondaryText}>✽ Running subagent…</Text>
        </Box>
      )}
    </Box>
  )
}
