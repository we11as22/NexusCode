import { Box, Text, useInput } from 'ink'
import React from 'react'
import { Select } from './CustomSelect/index.js'
import { getTheme } from '../utils/theme.js'

interface Props {
  onDone: () => void
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  // Handle Ctrl+C, Ctrl+D and Esc
  useInput((input, key) => {
    if ((key.ctrl && (input === 'c' || input === 'd')) || key.escape) {
      onDone()
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      padding={1}
      borderColor={getTheme().secondaryBorder}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          Estimated provider usage for this session has reached $5.
        </Text>
        <Text>Check your configured provider&apos;s billing dashboard for authoritative usage.</Text>
      </Box>
      <Box>
        <Select
          options={[
            {
              value: 'ok',
              label: 'Got it, thanks!',
            },
          ]}
          onChange={onDone}
        />
      </Box>
    </Box>
  )
}
