import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig } from '@nexuscode/core'

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  initialConfig: NexusConfig
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: (result?: CloseResult) => void
}

/** Single vector index: indexing.enabled and indexing.vector are toggled together. */
export function NexusIndexPanel({
  initialConfig,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const vectorOn = Boolean(
    (initialConfig.indexing?.enabled ?? true) && (initialConfig.indexing?.vector ?? false),
  )
  const [vectorEnabled, setVectorEnabled] = useState(vectorOn)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useInput((input, key) => {
    if (key.escape) {
      onClose({ cancelled: true })
      return
    }
    if (key.return || input === ' ') {
      const next = !vectorEnabled
      setVectorEnabled(next)
      setSaving(true)
      setError(null)
      onSave({
        indexing: {
          ...initialConfig.indexing,
          enabled: next,
          vector: next,
        },
      })
        .then(() => {
          setSaving(false)
          onClose({ saved: true })
        })
        .catch((e) => {
          setError(String(e))
          setSaving(false)
        })
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>Index</Text>
        <Text dimColor>Vector index for codebase_search (Qdrant + embeddings).</Text>
      </Box>
      <Box height={2}>
        <Text color={theme.primary}>{figures.pointer} Vector index: </Text>
        <Text color={theme.primary}>{vectorEnabled ? 'on' : 'off'}</Text>
      </Box>
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
        <Text dimColor>Enter/Space toggle · Esc close</Text>
      </Box>
    </Box>
  )
}
