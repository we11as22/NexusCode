/**
 * Subagent progress block shown above the todo list when a SpawnAgent subagent is running.
 * Matches reference: ● Mode(task), ⎿ tool uses, thinking line.
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

export function NexusSubagentBlock({
  subagentsByPartId,
  isLoading,
  expandToolDetails = false,
}: Props): React.ReactNode {
  const theme = getTheme()
  const allSubagents = useMemo(() => {
    return Object.values(subagentsByPartId).flat().sort((a, b) => b.startedAt - a.startedAt)
  }, [subagentsByPartId])

  const running = allSubagents.filter((sa) => sa.status === 'running')
  const primary = running[0]
  const otherRunningCount = Math.max(0, running.length - 1)

  if (!primary) return null

  const history = primary.toolHistory
  const visibleHistory = expandToolDetails ? history : history.slice(0, 3)
  const hiddenToolUses = Math.max(0, history.length - visibleHistory.length)

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      <Box>
        <Text color={theme.primary}>● </Text>
        <Text bold>{modeLabel(primary.mode)}({truncateTask(primary.task, 72)})</Text>
      </Box>
      {visibleHistory.length > 0 ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.primary}>  ⎿ </Text>
            <Text>{visibleHistory[0]}</Text>
          </Box>
          {visibleHistory.slice(1).map((line, idx) => (
            <Box key={`${primary.id}-tool-${idx}`}>
              <Text dimColor>     {line}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Box>
          <Text dimColor>  ⎿ Starting…</Text>
        </Box>
      )}
      {hiddenToolUses > 0 ? (
        <Box>
          <Text dimColor>     +{hiddenToolUses} more tool uses (ctrl+o to expand)</Text>
        </Box>
      ) : null}
      <Box>
        <Text dimColor>     ctrl+b to run in background</Text>
      </Box>
      {otherRunningCount > 0 ? (
        <Box>
          <Text dimColor>     +{otherRunningCount} more subagent{otherRunningCount === 1 ? '' : 's'} running</Text>
        </Box>
      ) : null}
      {(isLoading || running.length > 0) && (
        <Box>
          <Text color={theme.secondaryText}>✽ Running subagents…</Text>
        </Box>
      )}
    </Box>
  )
}
