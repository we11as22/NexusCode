import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, ProviderConfig } from '@nexuscode/core'
import { catalogSelectionToModel } from '@nexuscode/core'
import type { ModelsCatalog } from '@nexuscode/core'

type Props = {
  cwd: string
  initialConfig: NexusConfig
  catalog: ModelsCatalog | null
  catalogError: string | null
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: () => void
}

const CUSTOM_ID = '__custom__'
const NEXUS_GATEWAY = 'https://api.kilo.ai/api/gateway'

export function NexusModelPanel({
  cwd,
  initialConfig,
  catalog,
  catalogError,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [customMode, setCustomMode] = useState(false)
  const [customId, setCustomId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentId = initialConfig.model?.id ?? '—'
  const items = catalog
    ? [
        ...catalog.recommended.map((r) => ({
          key: `${r.providerId}:${r.modelId}`,
          label: r.free ? `${r.name} (free)` : r.name,
          providerId: r.providerId,
          modelId: r.modelId,
        })),
        { key: CUSTOM_ID, label: 'Custom model ID…', providerId: '', modelId: '' },
      ]
    : []

  useInput((input, key) => {
    if (customMode) {
      if (key.escape) {
        setCustomMode(false)
        setCustomId('')
        return
      }
      if (key.return) {
        const id = customId.trim()
        if (!id) return
        setSaving(true)
        setError(null)
        onSave({
          model: {
            provider: 'openai-compatible',
            id,
            baseUrl: NEXUS_GATEWAY,
          } as ProviderConfig,
        })
          .then(() => onClose())
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
        return
      }
      if (key.backspace || input === '\x7f') {
        setCustomId((s) => s.slice(0, -1))
        return
      }
      if (input && input.length === 1) {
        setCustomId((s) => s + input)
        return
      }
      return
    }

    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1))
      return
    }
    if (key.return || input === ' ') {
      const item = items[selectedIndex]
      if (!item) return
      if (item.key === CUSTOM_ID) {
        setCustomMode(true)
        return
      }
      if (!catalog) return
      const resolved = catalogSelectionToModel(item.providerId, item.modelId, catalog)
      setSaving(true)
      setError(null)
      onSave({
        model: {
          provider: resolved.provider as ProviderConfig['provider'],
          id: resolved.id,
          baseUrl: resolved.baseUrl,
        } as ProviderConfig,
      })
        .then(() => onClose())
        .catch((e) => {
          setError(String(e))
          setSaving(false)
        })
    }
  })

  if (customMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
        <Box marginBottom={1}>
          <Text bold>Model — Custom ID</Text>
        </Box>
        <Box>
          <Text color={theme.primary}>Model ID (e.g. minimax/minimax-m2.5:free): </Text>
          <Text>{customId}</Text>
          <Text color={theme.secondaryText}>|</Text>
        </Box>
        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter ID · Enter to save · Esc to cancel</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>Model</Text>
        <Text dimColor>Current: {currentId}</Text>
      </Box>
      {catalogError && (
        <Box marginBottom={1}>
          <Text color={theme.warning}>{catalogError}</Text>
        </Box>
      )}
      {items.length === 0 && !catalogError && (
        <Box>
          <Text dimColor>Loading catalog…</Text>
        </Box>
      )}
      {items.map((item, i) => {
        const isSelected = i === selectedIndex
        return (
          <Box key={item.key} height={1}>
            <Text color={isSelected ? theme.primary : undefined}>
              {isSelected ? figures.pointer : ' '} {item.label}
            </Text>
          </Box>
        )
      })}
      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · Enter choose · Esc close</Text>
      </Box>
    </Box>
  )
}
