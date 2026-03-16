import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import chalk from 'chalk'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, EmbeddingConfig } from '@nexuscode/core'
import { useFieldInput } from '../hooks/useFieldInput.js'

const EMBEDDING_PROVIDERS: Array<{ id: EmbeddingConfig['provider']; label: string }> = [
  { id: 'openai-compatible', label: 'OpenAI-compatible' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'google', label: 'Google' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'bedrock', label: 'Bedrock' },
  { id: 'local', label: 'Local' },
]

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  initialConfig: NexusConfig
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: (result?: CloseResult) => void
}

export function NexusEmbeddingsPanel({
  initialConfig,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const invert = chalk.inverse
  const emb = initialConfig.embeddings
  const [providerIndex, setProviderIndex] = useState(() => {
    const id = emb?.provider ?? 'openai-compatible'
    const i = EMBEDDING_PROVIDERS.findIndex((p) => p.id === id)
    return i >= 0 ? i : 0
  })
  const [modelId, setModelId] = useState(emb?.model ?? '')
  // focus: 0=provider, 1=model, 2=save
  const [focusIndex, setFocusIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelField = useFieldInput(modelId, setModelId, invert)

  const currentProvider = EMBEDDING_PROVIDERS[providerIndex]
  const providerId = currentProvider?.id ?? 'openai-compatible'

  const doSave = () => {
    if (!modelId.trim()) {
      setError('Model ID is required')
      setFocusIndex(1)
      return
    }
    setSaving(true)
    setError(null)
    const config: EmbeddingConfig = {
      provider: providerId,
      model: modelId.trim(),
    }
    onSave({ embeddings: config })
      .then(() => onClose({ saved: true }))
      .catch((e) => {
        setError(String(e))
        setSaving(false)
      })
  }

  useInput((input, key) => {
    // On model field, let field handle input first
    if (focusIndex === 1) {
      if (modelField.handleInput(input ?? '', key)) return
    }

    if (key.escape) {
      onClose({ cancelled: true })
      return
    }
    if (key.tab) {
      setFocusIndex((f) => (f + 1) % 3)
      return
    }
    if (key.backtab) {
      setFocusIndex((f) => (f - 1 + 3) % 3)
      return
    }
    if (key.upArrow) {
      if (focusIndex === 0) {
        setProviderIndex((prev) => Math.max(0, prev - 1))
      } else {
        setFocusIndex((f) => Math.max(0, f - 1))
      }
      return
    }
    if (key.downArrow) {
      if (focusIndex === 0) {
        setProviderIndex((prev) => Math.min(EMBEDDING_PROVIDERS.length - 1, prev + 1))
      } else {
        setFocusIndex((f) => Math.min(2, f + 1))
      }
      return
    }
    if (key.return) {
      if (focusIndex === 2) {
        doSave()
      } else {
        setFocusIndex((f) => Math.min(2, f + 1))
      }
      return
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Embeddings</Text>
        <Text dimColor>
          Current: {emb ? `${emb.provider} / ${emb.model}` : 'not set'}
        </Text>
      </Box>
      <Box>
        <Text color={focusIndex === 0 ? theme.primary : undefined}>
          {focusIndex === 0 ? figures.pointer : ' '} Provider:{' '}
        </Text>
        <Text>{currentProvider?.label ?? providerId}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={focusIndex === 1 ? theme.primary : undefined}>
          {focusIndex === 1 ? figures.pointer : ' '} Model:{' '}
        </Text>
        <Text>{focusIndex === 1 ? modelField.renderedValue : (modelId || '(required)')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={focusIndex === 2 ? theme.primary : undefined}>
          {focusIndex === 2 ? figures.pointer : ' '}{' '}
          <Text bold>{saving ? 'Saving…' : 'Save'}</Text>
        </Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ Tab navigate · type model · Enter next/save · Esc close</Text>
      </Box>
    </Box>
  )
}
