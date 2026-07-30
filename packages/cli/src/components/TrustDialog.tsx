import React from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from '../utils/theme.js'
import { Select } from '@inkjs/ui'
import {
  saveWorkspaceTrust,
} from '../utils/config.js'
import { PRODUCT_NAME } from '../constants/product.js'
import { logEvent } from '../services/statsig.js'
import { useExitOnCtrlCD } from '../hooks/useExitOnCtrlCD.js'

type Props = {
  workspacePath: string
  onDone(): void
}

export function TrustDialog({ workspacePath, onDone }: Props): React.ReactNode {
  const theme = getTheme()
  React.useEffect(() => {
    // Log when dialog is shown
    logEvent('trust_dialog_shown', {})
  }, [])

  function onChange(value: 'yes' | 'no') {
    switch (value) {
      case 'yes': {
        // Log when user accepts
        logEvent('trust_dialog_accept', {
          workspacePath,
        })

        saveWorkspaceTrust(workspacePath)
        onDone()
        break
      }
      case 'no': {
        process.exit(1)
        break
      }
    }
  }

  const exitState = useExitOnCtrlCD(() => process.exit(0))

  useInput((_input, key) => {
    if (key.escape) {
      process.exit(0)
      return
    }
  })

  return (
    <>
      <Box
        flexDirection="column"
        gap={1}
        padding={1}
        borderStyle="round"
        borderColor={theme.warning}
      >
        <Text bold color={theme.warning}>
          Do you trust the files in this folder?
        </Text>
        <Text bold>{workspacePath}</Text>

        <Box flexDirection="column" gap={1}>
          <Text>
            {PRODUCT_NAME} may read files in this folder. Reading untrusted
            files may cause {PRODUCT_NAME} to behave unexpectedly.
          </Text>
          <Text>
            With your permission {PRODUCT_NAME} may execute files in this
            folder. Executing untrusted code is unsafe.
          </Text>
          <Text dimColor>
            Review requested writes and commands. Approved local commands run
            inside the native OS sandbox when the platform backend is ready.
          </Text>
        </Box>

        <Select
          options={[
            { label: 'Yes, proceed', value: 'yes' },
            { label: 'No, exit', value: 'no' },
          ]}
          onChange={value => onChange(value as 'yes' | 'no')}
        />
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <>Enter to confirm · Esc to exit</>
          )}
        </Text>
      </Box>
    </>
  )
}
