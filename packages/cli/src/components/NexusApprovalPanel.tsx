/**
 * TUI panel for Nexus agent approval (write, execute, mcp, doom_loop).
 * Resolves tuiApprovalRef so the agent loop continues; matches host.ts readline UX.
 */
import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import { getTheme } from '../utils/theme.js'
import type { ApprovalAction, PermissionResult } from '@nexuscode/core'

type Props = {
  action: ApprovalAction
  partId: string
  approvalRef: { current: ((r: PermissionResult) => void) | null }
  onClose: () => void
}

const OPTIONS_EXECUTE = ' [y] Allow once  [n] Deny  [a] Always allow  [s] Allow all (session)  [e] Add to allowed  [i] Say what to do instead'
const OPTIONS_OTHER = ' [y] Allow once  [n] Deny  [a] Always allow  [s] Allow all (session)  [i] Say what to do instead'

export function NexusApprovalPanel({
  action,
  approvalRef,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [customInstruction, setCustomInstruction] = useState('')
  const [mode, setMode] = useState<'choose' | 'instruct'>('choose')

  const resolve = (result: PermissionResult) => {
    if (approvalRef.current) {
      approvalRef.current(result)
      approvalRef.current = null
    }
    onClose()
  }

  useInput((input, key) => {
    if (mode === 'instruct') {
      if (key.return) {
        resolve({ approved: false, whatToDoInstead: customInstruction.trim() || undefined })
        return
      }
      if (key.escape) {
        setMode('choose')
        setCustomInstruction('')
        return
      }
      if (key.backspace || input === '\x7f' || key.delete) {
        setCustomInstruction((s) => s.slice(0, -1))
        return
      }
      if (input != null && input !== '' && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setCustomInstruction((s) => s + input.replace(/\r\n?/g, ' ').replace(/\r/g, ' '))
      }
      return
    }

    const lower = input?.trim().toLowerCase() ?? ''
    if (key.escape) {
      resolve({ approved: false })
      return
    }
    if (lower === 'i' || lower === 'instruct') {
      setMode('instruct')
      return
    }
    if (lower === 'y' || lower === 'yes') {
      resolve({ approved: true })
      return
    }
    if (lower === 'n' || lower === 'no') {
      resolve({ approved: false })
      return
    }
    if (lower === 'a' || lower === 'always') {
      resolve({ approved: true, alwaysApprove: true })
      return
    }
    if (lower === 's' || lower === 'skip') {
      resolve({ approved: true, skipAll: true })
      return
    }
    if ((lower === 'e' || lower === 'add') && action.type === 'execute' && action.content) {
      const cmd = action.content.trim().replace(/\s+/g, ' ')
      resolve({ approved: true, addToAllowedCommand: cmd })
      return
    }
  })

  const isExecute = action.type === 'execute'
  const optionsLine = isExecute ? OPTIONS_EXECUTE : OPTIONS_OTHER

  if (mode === 'instruct') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
        <Box marginBottom={1}>
          <Text bold color={theme.primary}>What to do instead?</Text>
        </Box>
        <Box>
          <Text color={theme.primary}>{customInstruction}</Text>
          <Text color={theme.secondaryText}>|</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to send  ·  Esc back to options</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" marginBottom={1}>
        {action.type === 'execute' && (
          <>
            <Text bold color={theme.warning}>⌨  Bash</Text>
            <Text color={theme.primary}>  {action.content || action.description.replace(/^Run:\s*/i, '')}</Text>
          </>
        )}
        {action.type === 'write' && (
          <>
            <Text bold color={theme.success}>✏ File write requested</Text>
            <Text color={theme.primary}>  {action.description}</Text>
            {action.diff && (
              <Box flexDirection="column" marginTop={1}>
                {action.diff.split('\n').slice(0, 25).map((line, i) => (
                  <Text key={i} dimColor>
                    {line.startsWith('+') && !line.startsWith('+++') ? (
                      <Text color={theme.success}>{line}</Text>
                    ) : line.startsWith('-') && !line.startsWith('---') ? (
                      <Text color={theme.error}>{line}</Text>
                    ) : (
                      line
                    )}
                  </Text>
                ))}
                {action.diff.includes('(truncated)') && <Text dimColor>  ...</Text>}
              </Box>
            )}
          </>
        )}
        {action.type === 'mcp' && (
          <>
            <Text bold color={theme.secondaryText}>🔌 MCP tool call</Text>
            <Text color={theme.primary}>  {action.description}</Text>
          </>
        )}
        {action.type === 'doom_loop' && (
          <>
            <Text bold color={theme.error}>⚠ Potential infinite loop detected</Text>
            <Text color={theme.error}>  {action.description}</Text>
          </>
        )}
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{optionsLine}</Text>
      </Box>
      <Box>
        <Text bold>Allow? </Text>
      </Box>
    </Box>
  )
}
