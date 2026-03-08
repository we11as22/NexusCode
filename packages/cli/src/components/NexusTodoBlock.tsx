/**
 * Dynamic todo list block from Nexus agent (TodoWrite tool).
 * Matches reference: summary line (N tasks, X done, Y in progress, Z open), ✔/◼/◻, separator, footer.
 */
import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'

type TodoItem = {
  id?: string
  content?: string
  status?: string
  done?: boolean
  text?: string
  description?: string
}

function parseTodoList(todo: string): TodoItem[] {
  const s = todo.trim()
  if (!s) return []
  if (!s.startsWith('[')) return []
  try {
    const items = JSON.parse(s) as TodoItem[]
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

const SEPARATOR_CHAR = '─'

type Props = { todo: string }

export function NexusTodoBlock({ todo }: Props): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const items = useMemo(() => parseTodoList(todo), [todo])
  if (items.length === 0) return null

  const doneCount = items.filter(i => {
    const isTw = typeof i.id === 'string' && typeof i.content === 'string' && typeof i.status === 'string'
    return isTw ? (i.status === 'completed' || i.status === 'cancelled') : Boolean(i.done)
  }).length
  const inProgressCount = items.filter(i =>
    typeof i.id === 'string' && typeof i.content === 'string' && typeof i.status === 'string' && i.status === 'in_progress'
  ).length
  const openCount = items.length - doneCount - inProgressCount
  const summary = `${items.length} tasks (${doneCount} done, ${inProgressCount} in progress, ${openCount} open)`
  const separator = SEPARATOR_CHAR.repeat(Math.max(0, columns - 2))

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      <Box>
        <Text dimColor>  {summary}</Text>
      </Box>
      {items.map((item, i) => {
        const isTodoWrite = typeof item.id === 'string' && typeof item.content === 'string' && typeof item.status === 'string'
        const done = isTodoWrite
          ? item.status === 'completed' || item.status === 'cancelled'
          : Boolean(item.done)
        const content = isTodoWrite ? (item.content ?? '') : (item.text ?? '')
        const inProgress = isTodoWrite && item.status === 'in_progress'
        const icon = done ? '✔' : inProgress ? '◼' : '◻'

        return (
          <Box key={item.id ?? i}>
            <Text dimColor>  </Text>
            <Text color={done ? theme.success : inProgress ? theme.primary : undefined}>{icon} </Text>
            <Text
              color={inProgress ? theme.text : done ? theme.text : theme.text}
              dimColor={done}
              bold={inProgress}
            >
              {content}
            </Text>
          </Box>
        )
      })}
      <Box marginTop={0}><Text dimColor>{separator}</Text></Box>
      <Box marginTop={0}>
        <Text dimColor> esc to interrupt · ctrl+t to hide tasks</Text>
      </Box>
    </Box>
  )
}
