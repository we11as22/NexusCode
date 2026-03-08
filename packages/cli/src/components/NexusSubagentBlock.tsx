/**
 * Subagent progress block shown above the todo list when a SpawnAgents subagent is running.
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
}

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1).toLowerCase()
}

export function NexusSubagentBlock({
  subagentsByPartId,
  isLoading,
}: Props): React.ReactNode {
  const theme = getTheme()
  const running = useMemo(() => {
    const all = Object.values(subagentsByPartId).flat()
    const run = all.filter((sa) => sa.status === 'running')
    return run.sort((a, b) => b.startedAt - a.startedAt)[0]
  }, [subagentsByPartId])

  if (!running) return null

  const mode = modeLabel(running.mode)
  const task = truncateTask(running.task, 56)

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      <Box>
        <Text color={theme.primary}>● </Text>
        <Text bold>{mode}({task})</Text>
      </Box>
      <Box>
        <Text dimColor>  ⎿  </Text>
        <Text dimColor>
          {running.currentTool ? `${running.currentTool}(...)` : 'Starting…'}
        </Text>
      </Box>
      <Box>
        <Text dimColor>     +more (ctrl+o to expand)</Text>
      </Box>
      <Box>
        <Text dimColor>     ctrl+b to run in background</Text>
      </Box>
      {isLoading && (
        <Box>
          <Text color={theme.secondaryText}>✽ Thinking…</Text>
        </Box>
      )}
    </Box>
  )
}
