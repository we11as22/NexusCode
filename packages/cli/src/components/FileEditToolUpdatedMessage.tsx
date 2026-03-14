import { Hunk } from 'diff'
import { Box, Text } from 'ink'
import * as React from 'react'
import { intersperse } from '../utils/array.js'
import { getTheme } from '../utils/theme.js'
import { getCwd } from '../utils/state.js'
import { relative } from 'path'

type Props = {
  filePath: string
  structuredPatch: Hunk[]
  verbose: boolean
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  verbose,
}: Props): React.ReactNode {
  const numAdditions = structuredPatch.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('+')).length,
    0,
  )
  const numRemovals = structuredPatch.reduce(
    (count, hunk) => count + hunk.lines.filter(_ => _.startsWith('-')).length,
    0,
  )

  return (
    <Box flexDirection="column">
      <Text>
        {'  '}⎿ Updated{' '}
        <Text bold>{verbose ? filePath : relative(getCwd(), filePath)}</Text>
        {numAdditions > 0 || numRemovals > 0 ? ' with ' : ''}
        {numAdditions > 0 ? (
          <>
            <Text bold>{numAdditions}</Text>{' '}
            {numAdditions > 1 ? 'additions' : 'addition'}
          </>
        ) : null}
        {numAdditions > 0 && numRemovals > 0 ? ' and ' : null}
        {numRemovals > 0 ? (
          <>
            <Text bold>{numRemovals}</Text>{' '}
            {numRemovals > 1 ? 'removals' : 'removal'}
          </>
        ) : null}
      </Text>
      {intersperse(
        structuredPatch.map(_ => (
          <Box flexDirection="column" paddingLeft={5} key={_.newStart}>
            {_.lines
              .filter(line => line.startsWith('+') || line.startsWith('-'))
              .map((line, idx) => (
                <Text
                  key={`${_.newStart}-${idx}`}
                  color={
                    line.startsWith('+')
                      ? getTheme().diff.added
                      : getTheme().diff.removed
                  }
                >
                  {line}
                </Text>
              ))}
          </Box>
        )),
        i => (
          <Box paddingLeft={5} key={`ellipsis-${i}`}>
            <Text color={getTheme().secondaryText}>...</Text>
          </Box>
        ),
      )}
    </Box>
  )
}
