import { Box, Text } from 'ink'
import * as React from 'react'
import { getTheme } from '../../../utils/theme.js'
import { getCwd } from '../../../utils/state.js'
import { relative } from 'path'

export type AppliedReplacement = { oldSnippet: string; newSnippet: string }

const MAX_BLOCKS = 14
const MAX_LINES_PER_SNIPPET = 48

function clipLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  }
}

type Props = {
  filePath: string
  replacements: AppliedReplacement[]
  verbose: boolean
}

export function EditAppliedReplacementsPreview({
  filePath,
  replacements,
  verbose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const label = verbose ? filePath : relative(getCwd(), filePath)
  const blocks = replacements.slice(0, MAX_BLOCKS)
  const restBlocks = replacements.length - blocks.length
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}⎿ Updated{' '}
        <Text bold>{label}</Text>
      </Text>
      {blocks.map((pair, i) => {
        const oldClip = clipLines(pair.oldSnippet, MAX_LINES_PER_SNIPPET)
        const newClip = clipLines(pair.newSnippet, MAX_LINES_PER_SNIPPET)
        return (
          <Box key={i} flexDirection="column" paddingLeft={5} marginTop={i > 0 ? 1 : 0}>
            {oldClip.text.split('\n').map((line, li) => (
              <Text key={`o-${li}`} color={theme.diff.removed}>
                −{line || ' '}
              </Text>
            ))}
            {oldClip.truncated ? (
              <Text color={theme.secondaryText}>… (truncated)</Text>
            ) : null}
            {newClip.text.split('\n').map((line, li) => (
              <Text key={`n-${li}`} color={theme.diff.added}>
                +{line || ' '}
              </Text>
            ))}
            {newClip.truncated ? (
              <Text color={theme.secondaryText}>… (truncated)</Text>
            ) : null}
          </Box>
        )
      })}
      {restBlocks > 0 ? (
        <Text color={theme.secondaryText} marginLeft={5}>
          … {restBlocks} more replacement
          {restBlocks === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  )
}
