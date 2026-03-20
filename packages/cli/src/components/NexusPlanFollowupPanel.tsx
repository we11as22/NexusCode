import { Box, Text, useInput } from 'ink'
import React, { useMemo, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'
import { applyMarkdown } from '../utils/markdown.js'

const SEPARATOR_CHAR = '─'

type Props = {
  planText: string
  onImplement: () => void | Promise<void>
  onRevise: (instruction: string) => void | Promise<void>
  onDismiss: () => void
}

export function NexusPlanFollowupPanel({
  planText,
  onImplement,
  onRevise,
  onDismiss,
}: Props): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<'choose' | 'instruct'>('choose')
  const [instruction, setInstruction] = useState('')

  const options = useMemo(
    () => [
      'Yes, implement this plan',
      'No, and tell NexusCode what to do differently',
    ],
    [],
  )

  useInput((input, key) => {
    if (mode === 'instruct') {
      if (key.return) {
        const trimmed = instruction.trim()
        if (!trimmed) return
        void onRevise(trimmed)
        return
      }
      if (key.escape) {
        setMode('choose')
        setInstruction('')
        return
      }
      if (key.backspace || input === '\x7f' || key.delete) {
        setInstruction((s) => s.slice(0, -1))
        return
      }
      if (input != null && input !== '' && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setInstruction((s) => s + input.replace(/\r\n?/g, ' ').replace(/\r/g, ' '))
      }
      return
    }

    if (key.escape) {
      onDismiss()
      return
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => (i - 1 + options.length) % options.length)
      return
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => (i + 1) % options.length)
      return
    }
    if (input === '1') {
      void onImplement()
      return
    }
    if (input === '2') {
      setSelectedIndex(1)
      setMode('instruct')
      return
    }
    if (key.return) {
      if (selectedIndex === 0) {
        void onImplement()
      } else {
        setMode('instruct')
      }
    }
  })

  const separator = SEPARATOR_CHAR.repeat(Math.max(8, columns))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.secondaryBorder}>{separator}</Text>
      <Box marginTop={1}>
        <Text bold>Ready to code?</Text>
      </Box>
      <Box marginTop={1} borderStyle="single" borderColor={theme.secondaryBorder} paddingX={1} width={Math.max(20, columns - 2)}>
        <Text wrap="wrap">{applyMarkdown(planText)}</Text>
      </Box>
      {mode === 'choose' ? (
        <Box marginTop={1} flexDirection="column">
          {options.map((label, index) => (
            <Text key={label} color={index === selectedIndex ? theme.primary : undefined}>
              {index === selectedIndex ? '› ' : '  '}
              {index + 1}. {label}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>↑/↓ choose · Enter confirm · Esc dismiss</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text}>What should change in the plan?</Text>
          <Box marginTop={1} borderStyle="single" borderColor={theme.secondaryBorder} paddingX={1}>
            <Text>{instruction || ' '}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Type feedback · Enter submit revision · Esc back</Text>
          </Box>
        </Box>
      )}
      <Text color={theme.secondaryBorder}>{separator}</Text>
    </Box>
  )
}
