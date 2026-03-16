import { Box, Text, useInput } from 'ink'
import React, { useMemo, useRef, useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'

type Session = {
  id: string
  ts: number
  title?: string
  messageCount: number
}

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  sessions: Session[]
  onSelect: (session: Session) => void
  onClose: (result?: CloseResult) => void
}

const VISIBLE_ROWS = 10

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function NexusSessionsPanel({ sessions, onSelect, onClose }: Props): React.ReactNode {
  const theme = getTheme()

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  /** When set, show submenu (switch/back) for this session. */
  const [pendingSession, setPendingSession] = useState<Session | null>(null)
  const [submenuIndex, setSubmenuIndex] = useState(0)

  const selectedIndexRef = useRef(0)
  selectedIndexRef.current = selectedIndex

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.ts - a.ts),
    [sessions],
  )

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return sorted
    return sorted.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? '').toLowerCase().includes(q),
    )
  }, [sorted, query])

  // Clamp selection when filtered list shrinks
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1))
  if (clampedIndex !== selectedIndex && filtered.length > 0) {
    // Use ref to avoid render loop: update on next tick via state
  }

  const scrollStart = Math.max(0, Math.min(clampedIndex, filtered.length - VISIBLE_ROWS))
  const visibleItems = filtered.slice(scrollStart, scrollStart + VISIBLE_ROWS)

  useInput((input, key) => {
    // Submenu mode: switch / back
    if (pendingSession) {
      if (key.escape || input === 'b' || input === 'B') {
        setPendingSession(null)
        return
      }
      if (key.upArrow) {
        setSubmenuIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setSubmenuIndex((i) => Math.min(1, i + 1))
        return
      }
      if (key.return) {
        if (submenuIndex === 0) {
          // Switch
          onSelect(pendingSession)
        } else {
          // Back
          setPendingSession(null)
        }
        return
      }
      return
    }

    if (key.escape) {
      onClose({ cancelled: true })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1))
      return
    }

    if (key.return) {
      const session = filtered[clampedIndex]
      if (session) {
        setPendingSession(session)
        setSubmenuIndex(0)
      }
      return
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    // Printable characters go into the search query
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setQuery((q) => q + input)
      setSelectedIndex(0)
      return
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      marginTop={1}
    >
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>Sessions</Text>
        <Box>
          <Text dimColor>Search: </Text>
          <Text>{query}</Text>
          <Text color={theme.primary}>_</Text>
        </Box>
      </Box>

      {filtered.length === 0 ? (
        <Box minHeight={3}>
          <Text dimColor>{sessions.length === 0 ? 'No sessions found.' : 'No matches.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" minHeight={Math.min(filtered.length, VISIBLE_ROWS)}>
          {visibleItems.map((session, i) => {
            const globalIndex = scrollStart + i
            const isSelected = globalIndex === clampedIndex
            const shortId = session.id.slice(0, 8)
            const title = session.title ? ` ${session.title}` : ''
            const date = formatDate(session.ts)
            const msgCount = `${session.messageCount} msg${session.messageCount !== 1 ? 's' : ''}`
            return (
              <Box key={session.id} height={1}>
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? figures.pointer : ' '}{' '}
                </Text>
                <Text color={isSelected ? theme.primary : undefined}>{shortId}</Text>
                {title ? (
                  <Text color={isSelected ? theme.primary : undefined}>{title}</Text>
                ) : null}
                <Text dimColor>  {date}  {msgCount}</Text>
              </Box>
            )
          })}
        </Box>
      )}

      {pendingSession && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.secondaryBorder} paddingX={1}>
          <Text bold>Session: <Text dimColor>{pendingSession.id.slice(0, 8)}</Text>{pendingSession.title ? ` ${pendingSession.title}` : ''}</Text>
          <Box flexDirection="column" marginTop={1}>
            {(['Switch', 'Back'] as const).map((label, i) => (
              <Box key={label} height={1}>
                <Text color={submenuIndex === i ? theme.primary : undefined}>
                  {submenuIndex === i ? figures.pointer : ' '} {label}
                </Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑/↓ navigate · Enter confirm · Esc back</Text>
          </Box>
        </Box>
      )}
      {!pendingSession && (
        <Box marginTop={1}>
          <Text dimColor>↑/↓ navigate · Enter select · type to search · Esc close</Text>
        </Box>
      )}
    </Box>
  )
}
