/**
 * Session diff block: "▶ N files" with list of changed files (+additions -deletions).
 * Data comes from session messages (completed Write/Edit tool parts with path + diffStats).
 */
import { Box, Text } from 'ink'
import React from 'react'
import { getTheme } from '../utils/theme.js'

export type SessionDiffEntry = { file: string; additions: number; deletions: number }

type Props = {
  entries: SessionDiffEntry[]
}

const SEPARATOR_CHAR = '─'

export function NexusSessionDiffBlock({ entries }: Props): React.ReactNode {
  const theme = getTheme()

  if (entries.length === 0) return null

  const n = entries.length
  const label = n === 1 ? '1 file' : `${n} files`

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
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
      <Box marginTop={0}><Text dimColor>{SEPARATOR_CHAR.repeat(40)}</Text></Box>
    </Box>
  )
}
