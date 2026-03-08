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
  /** Connect or start Qdrant at URL; progress is logged to terminal. */
  onConnectQdrant?: (url: string) => Promise<void>
}

export function NexusVectorPanel({
  initialConfig,
  onSave,
  onClose,
  onConnectQdrant,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [vectorIndexEnabled, setVectorIndexEnabled] = useState(
    Boolean(initialConfig.indexing?.vector),
  )
  const [vectorDbEnabled, setVectorDbEnabled] = useState(
    Boolean(initialConfig.vectorDb?.enabled),
  )
  const [vectorDbUrl, setVectorDbUrl] = useState(
    initialConfig.vectorDb?.url ?? 'http://127.0.0.1:6333',
  )
  const [saving, setSaving] = useState(false)
  const [connectingQdrant, setConnectingQdrant] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fieldCount = 5

  /** Enter: submit on "Save" row (index 3), toggle on 0/1, edit URL on 2 */
  const isEnter = (key: { return?: boolean }, inp: string) =>
    key.return || inp === '\r' || inp === '\n'

  useInput((input, key) => {
    if (key.escape) {
      onClose({ cancelled: true })
      return
    }
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) setSelectedIndex((i) => Math.min(fieldCount - 1, i + 1))
    if (key.backspace || input === '\x7f' || key.delete) {
      if (selectedIndex === 1) setVectorDbUrl((s) => s.slice(0, -1))
      return
    }
    if (selectedIndex === 1 && input != null && input !== '' && input !== '\r' && input !== '\n') {
      const printable = input.replace(/[\x00-\x1f\x7f]/g, '')
      if (printable) setVectorDbUrl((s) => s + printable)
      return
    }
    if (isEnter(key, input ?? '') || input === ' ') {
      if (selectedIndex === 0) {
        setVectorIndexEnabled((v) => !v)
        return
      }
      if (selectedIndex === 1) return
      if (selectedIndex === 2 && onConnectQdrant) {
        setError(null)
        setConnectingQdrant(true)
        const url = vectorDbUrl.trim() || 'http://127.0.0.1:6333'
        onConnectQdrant(url)
          .then(() => setConnectingQdrant(false))
          .catch((e) => {
            setError(String(e))
            setConnectingQdrant(false)
          })
        return
      }
      if (selectedIndex === 3) {
        setVectorDbEnabled((v) => !v)
        return
      }
      if (selectedIndex === 4) {
        setSaving(true)
        setError(null)
        const url = vectorDbUrl.trim() || 'http://127.0.0.1:6333'
        onSave({
          indexing: {
            ...initialConfig.indexing,
            enabled: initialConfig.indexing?.enabled ?? true,
            vector: vectorIndexEnabled,
          },
          vectorDb: {
            enabled: vectorDbEnabled,
            url,
            collection: initialConfig.vectorDb?.collection ?? 'nexus',
            autoStart: initialConfig.vectorDb?.autoStart ?? true,
          },
        })
          .then(() => onClose({ saved: true }))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      }
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={16}>
      <Box marginBottom={1}>
        <Text bold>Vector DB &amp; semantic index</Text>
      </Box>
      <Text dimColor>Off by default. Enable to use codebase_search (Qdrant + embeddings).</Text>
      <Box flexDirection="column" height={6} marginTop={1}>
        <Box height={1}>
          <Text color={selectedIndex === 0 ? theme.primary : undefined}>
            {selectedIndex === 0 ? figures.pointer : ' '} Vector index (semantic search):
          </Text>
          <Text>{vectorIndexEnabled ? 'on' : 'off'}</Text>
        </Box>
        <Box height={1}>
          <Text color={selectedIndex === 1 ? theme.primary : undefined}>
            {selectedIndex === 1 ? figures.pointer : ' '} Vector DB URL (Qdrant):
          </Text>
          <Text>{vectorDbUrl || '—'}</Text>
        </Box>
        <Box height={1}>
          <Text color={selectedIndex === 2 ? theme.primary : undefined}>
            {selectedIndex === 2 ? figures.pointer : ' '} Connect / Start Qdrant
          </Text>
          {connectingQdrant ? <Text dimColor> …</Text> : null}
        </Box>
        <Box height={1}>
          <Text color={selectedIndex === 3 ? theme.primary : undefined}>
            {selectedIndex === 3 ? figures.pointer : ' '} Vector DB enabled (use for indexer):
          </Text>
          <Text>{vectorDbEnabled ? 'on' : 'off'}</Text>
        </Box>
        <Box height={1}>
          <Text color={selectedIndex === 4 ? theme.primary : undefined}>
            {selectedIndex === 4 ? figures.pointer : ' '} Save and start
          </Text>
        </Box>
      </Box>
      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      {saving && (
        <Box marginTop={1}>
          <Text dimColor>Saving and starting…</Text>
        </Box>
      )}
      {connectingQdrant && !saving && (
        <Box marginTop={1}>
          <Text dimColor>Connecting / starting Qdrant…</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · Enter/Space toggle / Connect / Save · Esc close</Text>
      </Box>
    </Box>
  )
}
