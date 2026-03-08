/**
 * TUI panel for Nexus agent approval (write, execute, mcp, doom_loop).
 * Layout matches reference: full-width separator, header, command/description, numbered options, footer.
 * Resolves tuiApprovalRef so the agent loop continues.
 */
import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'
import type { ApprovalAction, PermissionResult } from '@nexuscode/core'

const SEPARATOR_CHAR = '─'

type DiffSegment = { type: 'context' | 'remove' | 'add'; lineNum: number; text: string }

/** Parse unified diff into segments with line numbers for reference-style display. */
function parseUnifiedDiffToLines(diffStr: string): { filePath?: string; lines: DiffSegment[] } {
  const lines = diffStr.split(/\r?\n/)
  let filePath: string | undefined
  const out: DiffSegment[] = []
  let oldLineNum = 0
  let newLineNum = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const pathPart = line.slice(4).replace(/^[ab]\//, '').trim()
      if (pathPart && pathPart !== '/dev/null') filePath = pathPart
      continue
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      oldLineNum = parseInt(hunkMatch[1]!, 10)
      newLineNum = parseInt(hunkMatch[3]!, 10)
      continue
    }
    if (line.startsWith('\\')) continue // \ No newline at end of file
    if (line.startsWith(' ')) {
      out.push({ type: 'context', lineNum: oldLineNum, text: line.slice(1) })
      oldLineNum++
      newLineNum++
    } else if (line.startsWith('-')) {
      out.push({ type: 'remove', lineNum: oldLineNum, text: line.slice(1) })
      oldLineNum++
    } else if (line.startsWith('+')) {
      out.push({ type: 'add', lineNum: newLineNum, text: line.slice(1) })
      newLineNum++
    }
  }
  return { filePath, lines: out }
}

/** Extract file path from Write/Edit action description (e.g. "Write to path" → path). */
function getWriteFilePath(description: string): string {
  const m = /^(?:Write to|Edit) (.+)$/.exec(description.trim())
  return m ? m[1]! : description
}

function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  const half = Math.floor((maxLen - 1) / 2)
  return str.slice(0, half) + '…' + str.slice(-half)
}

/** Derive an allow pattern from a bash command for "don't ask again for this pattern" (e.g. npm run build → npm run:*). */
function deriveAllowPattern(command: string): string | undefined {
  const c = command.trim().replace(/\s+/g, ' ')
  if (/npm\s+run\s+/.test(c)) return 'npm run:*'
  if (/pnpm\s+run\s+/.test(c)) return 'pnpm run:*'
  if (/pnpm\s+/.test(c)) return 'pnpm *'
  if (/yarn\s+/.test(c)) return 'yarn *'
  if (/npx\s+/.test(c)) return 'npx *'
  return undefined
}

type Props = {
  action: ApprovalAction
  partId: string
  approvalRef: { current: ((r: PermissionResult) => void) | null }
  onClose: () => void
  /** Current workspace path; shown in MCP "don't ask again" option (e.g. "commands in /path/to/project"). */
  cwd?: string
}

const EXECUTE_OPTIONS_BASE: Array<{
  label: string
  result: (action: ApprovalAction) => PermissionResult
  /** When set, this option is only shown when derived pattern equals this (e.g. "npm run:*"). */
  patternOnly?: string
}> = [
  { label: 'Yes', result: () => ({ approved: true }) },
  {
    label: 'Yes, and don\'t ask again for: __PATTERN__',
    patternOnly: '__PATTERN__',
    result: (a) =>
      a.type === 'execute' && a.content
        ? { approved: true, addToAllowedPattern: deriveAllowPattern(a.content.trim().replace(/\s+/g, ' '))! }
        : { approved: true },
  },
  { label: 'No', result: () => ({ approved: false }) },
  { label: 'Always allow', result: () => ({ approved: true, alwaysApprove: true }) },
  { label: 'Allow all (session)', result: () => ({ approved: true, skipAll: true }) },
  {
    label: 'Add to allowed',
    result: (a) =>
      a.type === 'execute' && a.content
        ? { approved: true, addToAllowedCommand: a.content.trim().replace(/\s+/g, ' ') }
        : { approved: true },
  },
  { label: 'Say what to do instead', result: () => ({ approved: false, whatToDoInstead: '__instruct__' }) },
]

function getExecuteOptions(action: ApprovalAction): Array<{ label: string; result: (action: ApprovalAction) => PermissionResult }> {
  const cmd = action.type === 'execute' && action.content ? action.content.trim().replace(/\s+/g, ' ') : ''
  const pattern = deriveAllowPattern(cmd)
  return EXECUTE_OPTIONS_BASE.filter(opt => {
    if (opt.patternOnly === undefined) return true
    return pattern != null && opt.patternOnly === '__PATTERN__'
  }).map(opt => {
    if (opt.patternOnly === '__PATTERN__' && pattern != null) {
      return { label: `Yes, and don't ask again for: ${pattern}`, result: (a: ApprovalAction) => ({ approved: true, addToAllowedPattern: pattern }) }
    }
    return { label: opt.label, result: opt.result }
  })
}

function getMcpOptions(action: ApprovalAction, cwd?: string): Array<{ label: string; result: (action: ApprovalAction) => PermissionResult }> {
  return MCP_OPTIONS.map(opt =>
    opt.label === "Yes, and don't ask again for: __TOOL__"
      ? {
          label: cwd
            ? `Yes, and don't ask again for ${action.tool} commands in ${cwd}`
            : `Yes, and don't ask again for: ${action.tool}`,
          result: (a: ApprovalAction) => ({ approved: true, addToAllowedMcpTool: a.tool }),
        }
      : opt
  )
}

const OTHER_OPTIONS: Array<{
  label: string
  result: (action: ApprovalAction) => PermissionResult
}> = [
  { label: 'Yes', result: () => ({ approved: true }) },
  { label: 'No', result: () => ({ approved: false }) },
  { label: 'Always allow', result: () => ({ approved: true, alwaysApprove: true }) },
  { label: 'Allow all (session)', result: () => ({ approved: true, skipAll: true }) },
  { label: 'Say what to do instead', result: () => ({ approved: false, whatToDoInstead: '__instruct__' }) },
]

const MCP_OPTIONS: Array<{
  label: string
  result: (action: ApprovalAction) => PermissionResult
}> = [
  { label: 'Yes', result: () => ({ approved: true }) },
  {
    label: 'Yes, and don\'t ask again for: __TOOL__',
    result: (a) =>
      a.type === 'mcp' && a.tool
        ? { approved: true, addToAllowedMcpTool: a.tool }
        : { approved: true },
  },
  { label: 'No', result: () => ({ approved: false }) },
  { label: 'Always allow', result: () => ({ approved: true, alwaysApprove: true }) },
  { label: 'Allow all (session)', result: () => ({ approved: true, skipAll: true }) },
  { label: 'Say what to do instead', result: () => ({ approved: false, whatToDoInstead: '__instruct__' }) },
]

export function NexusApprovalPanel({
  action,
  approvalRef,
  onClose,
  cwd,
}: Props): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const [customInstruction, setCustomInstruction] = useState('')
  const [mode, setMode] = useState<'choose' | 'instruct'>('choose')

  const options = action.type === 'execute' ? getExecuteOptions(action) : action.type === 'mcp' ? getMcpOptions(action, cwd) : OTHER_OPTIONS
  const optionCount = options.length
  const [selectedIndex, setSelectedIndex] = useState(0)

  const resolve = (result: PermissionResult) => {
    if (result.whatToDoInstead === '__instruct__') {
      setMode('instruct')
      return
    }
    if (approvalRef.current) {
      approvalRef.current(result)
      approvalRef.current = null
    }
    onClose()
  }

  useInput((input, key) => {
    if (mode === 'instruct') {
      if (key.return) {
        const instruction = customInstruction.trim() || undefined
        if (approvalRef.current) {
          approvalRef.current({ approved: false, whatToDoInstead: instruction })
          approvalRef.current = null
        }
        onClose()
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

    if (key.escape) {
      if (approvalRef.current) {
        approvalRef.current({ approved: false })
        approvalRef.current = null
      }
      onClose()
      return
    }
    if (key.tab) {
      setMode('instruct')
      return
    }
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + optionCount) % optionCount)
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % optionCount)
      return
    }
    if (key.return) {
      const opt = options[selectedIndex]
      if (opt) {
        const result = opt.result(action)
        resolve(result)
      }
      return
    }

    const lower = input?.trim().toLowerCase() ?? ''
    if (lower === 'i' || lower === 'instruct') {
      setMode('instruct')
      return
    }
    const num = parseInt(lower, 10)
    if (num >= 1 && num <= optionCount) {
      const opt = options[num - 1]
      if (opt) {
        const result = opt.result(action)
        resolve(result)
      }
      return
    }
  })

  const separator = SEPARATOR_CHAR.repeat(Math.max(0, columns - 2))

  if (mode === 'instruct') {
    return (
      <Box flexDirection="column">
        <Box><Text dimColor>{separator}</Text></Box>
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
      </Box>
    )
  }

  const descriptionLine =
    action.type === 'execute'
      ? (action.shortDescription ?? (action.description.replace(/^Run:\s*/i, '').trim() || 'Run command'))
      : action.description

  return (
    <Box flexDirection="column">
      <Box><Text dimColor>{separator}</Text></Box>
      <Box flexDirection="column" paddingX={0} marginTop={0}>
        {action.type === 'execute' && (
          <>
            <Box marginTop={1}>
              <Text bold> Bash command</Text>
            </Box>
            <Box marginTop={0}>
              <Text color={theme.primary}>
                {'  '}
                {truncateMiddle(action.content || action.description.replace(/^Run:\s*/i, ''), columns - 6)}
              </Text>
            </Box>
            <Box marginTop={0}>
              <Text dimColor>  {descriptionLine}</Text>
            </Box>
            {action.warning && (
              <Box marginTop={0}>
                <Text color={theme.warning}>  {action.warning}</Text>
              </Box>
            )}
          </>
        )}
        {action.type === 'write' && (
          <>
            <Box marginTop={1}>
              <Text bold>• Update({getWriteFilePath(action.description)})</Text>
            </Box>
            {action.diffStats && (
              <Box marginTop={0}>
                <Text dimColor>
                  {' '}
                  Added {action.diffStats.added} line{action.diffStats.added !== 1 ? 's' : ''}, removed{' '}
                  {action.diffStats.removed} line{action.diffStats.removed !== 1 ? 's' : ''}.
                </Text>
              </Box>
            )}
            {action.diff && (() => {
              const { lines } = parseUnifiedDiffToLines(action.diff)
              const maxLines = 28
              const showLines = lines.slice(0, maxLines)
              const truncated = lines.length > maxLines
              const nums = showLines.map((l) => l.lineNum)
              const lineNumWidth = nums.length ? Math.max(3, String(Math.max(...nums)).length) : 3
              return (
                <Box flexDirection="column" marginTop={1}>
                  {showLines.map((seg, i) => (
                    <Box key={i}>
                      <Text dimColor>
                        {seg.lineNum.toString().padStart(lineNumWidth)}{' '}
                        {seg.type === 'remove' ? (
                          <Text color={theme.diff.removed}>- {seg.text}</Text>
                        ) : seg.type === 'add' ? (
                          <Text color={theme.diff.added}>+ {seg.text}</Text>
                        ) : (
                          <>  {seg.text}</>
                        )}
                      </Text>
                    </Box>
                  ))}
                  {(truncated || action.diff.includes('(truncated)')) && (
                    <Box>
                      <Text dimColor>  ...</Text>
                    </Box>
                  )}
                </Box>
              )
            })()}
          </>
        )}
        {action.type === 'mcp' && (
          <>
            <Box marginTop={1}>
              <Text bold> Tool use</Text>
            </Box>
            <Box marginTop={0}>
              <Text color={theme.primary}>
                {'  '}
                {truncateMiddle(action.description || action.tool, columns - 10)} (MCP)
              </Text>
            </Box>
            {action.shortDescription ? (
              <Box marginTop={0}>
                <Text dimColor>  {action.shortDescription}</Text>
              </Box>
            ) : null}
          </>
        )}
        {action.type === 'doom_loop' && (
          <>
            <Box marginTop={1}>
              <Text bold color={theme.error}> Potential infinite loop</Text>
            </Box>
            <Box marginTop={0}>
              <Text color={theme.error}>  {action.description}</Text>
            </Box>
          </>
        )}
        <Box marginTop={1}>
          <Text> Do you want to proceed?</Text>
        </Box>
        {options.map((opt, i) => (
          <Box key={i}>
            <Text color={i === selectedIndex ? theme.primary : undefined}>
              {i === selectedIndex ? ' ❯ ' : '   '}
              {i + 1}. {opt.label}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor> Esc to cancel · Tab to amend</Text>
        </Box>
      </Box>
      <Box><Text dimColor>{separator}</Text></Box>
    </Box>
  )
}
