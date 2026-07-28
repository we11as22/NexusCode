import React from 'react'
import { Text } from 'ink'

export function MCPServerDialogCopy(): React.ReactNode {
  return (
    <>
      <Text>
        MCP servers provide additional functionality to the assistant. They may execute
        code, make network requests, or access system resources via tool calls.
        Tool calls remain subject to the active NexusCode mode, permission
        rules, and explicit approval policy. Only enable servers you trust.
      </Text>

      <Text dimColor>
        Remember: You can always change these choices later by running `nexus
        mcp reset-mcprc-choices`
      </Text>
    </>
  )
}
