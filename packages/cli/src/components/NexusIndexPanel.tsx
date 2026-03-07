import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig } from '@nexuscode/core'

type Props = {
  initialConfig: NexusConfig
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: () => void
}

export function NexusIndexPanel({
  initialConfig,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [indexEnabled, setIndexEnabled] = useState(initialConfig.indexing?.enabled ?? true)
  const [vectorEnabled, setVectorEnabled] = useState(initialConfig.indexing?.vector ?? false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = [
    { key: 'index', label: 'Index (symbols)', value: indexEnabled },
    { key: 'vector', label: 'Vector (semantic search)', value: vectorEnabled },
  ]

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(rows.length - 1, prev + 1))
      return
    }
    if (key.return || input === ' ') {
      const row = rows[selectedIndex]
      if (!row) return
      if (row.key === 'index') {
        const next = !indexEnabled
        setIndexEnabled(next)
        setSaving(true)
        setError(null)
        onSave({
          indexing: {
            ...initialConfig.indexing,
            enabled: next,
            vector: vectorEnabled,
          },
        })
          .then(() => setSaving(false))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      } else {
        const next = !vectorEnabled
        setVectorEnabled(next)
        setSaving(true)
        setError(null)
        onSave({
          indexing: {
            ...initialConfig.indexing,
            enabled: indexEnabled,
            vector: next,
          },
        })
          .then(() => setSaving(false))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      }
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>Index</Text>
        <Text dimColor>Codebase indexing and vector search</Text>
      </Box>
      {rows.map((row, i) => {
        const isSelected = i === selectedIndex
        return (
          <Box key={row.key} height={2}>
            <Text color={isSelected ? theme.primary : undefined}>
              {isSelected ? figures.pointer : ' '} {row.label}:{' '}
            </Text>
            <Text color={isSelected ? theme.primary : undefined}>{row.value ? 'on' : 'off'}</Text>
          </Box>
        )
      })}
      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      {saving && (
        <Box>
          <Text dimColor>Saving…</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · Enter/Space toggle · Esc close</Text>
      </Box>
    </Box>
  )
}
