import { Hunk } from 'diff'
import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '../utils/theme.js'
import { getCwd } from '../utils/state.js'
import { relative } from 'path'

const MAX_CHANGED_LINES = 96

type Props = {
  filePath: string
  structuredPatch: Hunk[]
  verbose: boolean
  /** When the changed-line list is truncated, show total +/− from the tool. */
  diffStats?: { added: number; removed: number }
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  verbose,
  diffStats,
}: Props): React.ReactNode {
  const changeLines = structuredPatch.flatMap(h =>
    h.lines.filter(line => line.startsWith('+') || line.startsWith('-')),
  )
  const shown = changeLines.slice(0, MAX_CHANGED_LINES)
  const omitted = changeLines.length - shown.length
  const label = verbose ? filePath : relative(getCwd(), filePath)

  return (
    <Box flexDirection="column">
      <Text>
        {'  '}⎿ Updated{' '}
        <Text bold>{label}</Text>
      </Text>
      <Box flexDirection="column" paddingLeft={5}>
        {shown.map((line, idx) => (
          <Text
            key={`chg-${idx}`}
            color={
              line.startsWith('+')
                ? getTheme().diff.added
                : getTheme().diff.removed
            }
          >
            {line}
          </Text>
        ))}
        {omitted > 0 ? (
          <Text color={getTheme().secondaryText}>
            … {omitted} more changed line{omitted === 1 ? '' : 's'}
            {diffStats != null
              ? ` (+${diffStats.added}/−${diffStats.removed} total)`
              : ''}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}
