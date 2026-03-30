/**
 * Session diff block: horizontal rule separates chat (agent output) from this summary,
 * then "▶ N files" and per-file (+/-) lines. Placed directly above the prompt.
 */
import { Box, Text } from 'ink'
import React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'

export type SessionDiffEntry = { file: string; additions: number; deletions: number }

type Props = {
  entries: SessionDiffEntry[]
}

const SEPARATOR_CHAR = '─'

export function NexusSessionDiffBlock({ entries }: Props): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const ruleLen = Math.max(12, Math.min(columns - 2, 80))

  if (entries.length === 0) return null

  const n = entries.length
  const label = n === 1 ? '1 file' : `${n} files`

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0} paddingX={1}>
      <Box>
        <Text dimColor>{SEPARATOR_CHAR.repeat(ruleLen)}</Text>
      </Box>
      <Box>
        <Text dimColor bold>▶ {label}</Text>
      </Box>
      {entries.map((e, i) => (
        <Box key={`${e.file}-${i}`}>
          <Text dimColor>  </Text>
          <Text color={theme.text}>{e.file}</Text>
          {(e.additions > 0 || e.deletions > 0) && (
            <Text dimColor>
              {' '}
              {e.additions > 0 && <Text color={theme.diff.added}>+{e.additions}</Text>}
              {e.deletions > 0 && <Text color={theme.diff.removed}>-{e.deletions}</Text>}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
