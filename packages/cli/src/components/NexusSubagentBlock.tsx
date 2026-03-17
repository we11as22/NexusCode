/**
 * Subagent progress block. Layout:
 *
 * 1 agent:
 *   ● Explore(task)
 *     ⎿ Read(file.ts)
 *            Grep(pattern)
 *          +N more tool uses (ctrl+o to expand)
 *          ctrl+b to run in background
 *
 * N agents:
 *   Running N subagents…
 *     ● Explore(task1)
 *       ⎿ Read(file.ts)
 *              Grep(pattern)
 *            +N more tool uses (ctrl+o to expand)
 *            ctrl+b to run in background
 *     ● Explore(task2)
 *       ⎿ List(src/)
 *            ctrl+b to run in background
 */
import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { getTheme } from '../utils/theme.js'
import type { SubAgentState } from '../nexus-subagents.js'
import { truncateTask } from '../nexus-subagents.js'

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
 *        ctrl+b…             ← "     " = 5sp
 */
export function ToolHistorySection({
  history,
  expandToolDetails,
  agentId,
  theme,
}: {
  history: string[]
  expandToolDetails: boolean
  agentId: string
  theme: ReturnType<typeof getTheme>
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
      <Box>
        <Text dimColor>    ctrl+b to run in background</Text>
      </Box>
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
  isLoading,
  expandToolDetails = false,
}: Props): React.ReactNode {
  const theme = getTheme()

  const allSubagents = useMemo(() => {
    return Object.values(subagentsByPartId).flat().sort((a, b) => a.startedAt - b.startedAt)
  }, [subagentsByPartId])

  const running = allSubagents.filter((sa) => sa.status === 'running')

  // Only show live running agents; completed agents appear inline in the chat history
  if (running.length === 0) return null

  const isMulti = running.length > 1

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Multi-agent running header */}
      {isMulti && (
        <Box>
          <Text color={theme.primary}>✽ </Text>
          <Text bold>Running {running.length} subagents…</Text>
        </Box>
      )}

      {/* Each agent — indented by 2 when multi, flat when single */}
      {running.map((sa) => (
        <Box key={sa.id} paddingLeft={isMulti ? 2 : 0} flexDirection="column">
          <AgentBlock sa={sa} expandToolDetails={expandToolDetails} theme={theme} />
        </Box>
      ))}

      {/* Single agent running spinner */}
      {!isMulti && (
        <Box>
          <Text color={theme.secondaryText}>✽ Running subagent…</Text>
        </Box>
      )}
    </Box>
  )
}
