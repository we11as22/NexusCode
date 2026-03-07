import { Box, Text } from 'ink'
import React from 'react'
import { getTheme } from '../utils/theme.js'

export function AsciiLogo(): React.ReactNode {
  const theme = getTheme()
  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Text color={theme.primary}>
        {` _   _ ______  _   _ ____   ____ _____ 
| \\ | |  _ \\ \\/ / | / ___| / ___| ____|
|  \\| | |_) \\  /  | \\___ \\| |   |  _|  
| |\\  |  __/ /  \\ | |___) | |___| |___ 
|_| \\_|_|   /_/\\_\\|____/  \\____|_____|
  ____  _____ ____ _____ 
 / _ \\| ____/ ___| ____|
| | | |  _| |   |  _|  
| |_| | |___|___| |___ 
 \\___/|_____\\____|_____|`}
      </Text>
    </Box>
  )
}
