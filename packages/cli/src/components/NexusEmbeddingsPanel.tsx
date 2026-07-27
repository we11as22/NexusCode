import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import chalk from 'chalk'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, EmbeddingConfig } from '@nexuscode/core'
import { useFieldInput } from '../hooks/useFieldInput.js'
import { asExtendedKey } from '../utils/ink.js'

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
  onRemoveApiKey: () => Promise<void>
  onClose: (result?: CloseResult) => void
}

export function NexusEmbeddingsPanel({
  initialConfig,
  onSave,
  onRemoveApiKey,
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
  const [baseUrl, setBaseUrl] = useState(emb?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  // focus: 0=provider, 1=model, 2=base URL, 3=API key, 4=remove, 5=save
  const [focusIndex, setFocusIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelField = useFieldInput(modelId, setModelId, invert)
  const baseUrlField = useFieldInput(baseUrl, setBaseUrl, invert)
  const apiKeyField = useFieldInput(apiKey, setApiKey, invert, {
    maskChar: '•',
  })

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
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }
    onSave({ embeddings: config })
      .then(() => onClose({ saved: true }))
      .catch((e) => {
        setError(String(e))
        setSaving(false)
      })
  }

  useInput((input, key) => {
    const extendedKey = asExtendedKey(key)
    // On model field, let field handle input first
    if (focusIndex >= 1 && focusIndex <= 3) {
      const handler = [
        modelField.handleInput,
        baseUrlField.handleInput,
        apiKeyField.handleInput,
      ][focusIndex - 1]
      if (handler?.(input ?? '', extendedKey)) return
    }

    if (extendedKey.escape) {
      onClose({ cancelled: true })
      return
    }
    if (extendedKey.tab) {
      setFocusIndex((f) => (f + 1) % 6)
      return
    }
    if (extendedKey.backtab) {
      setFocusIndex((f) => (f - 1 + 6) % 6)
      return
    }
    if (extendedKey.upArrow) {
      if (focusIndex === 0) {
        setProviderIndex((prev) => Math.max(0, prev - 1))
      } else {
        setFocusIndex((f) => Math.max(0, f - 1))
      }
      return
    }
    if (extendedKey.downArrow) {
      if (focusIndex === 0) {
        setProviderIndex((prev) => Math.min(EMBEDDING_PROVIDERS.length - 1, prev + 1))
      } else {
        setFocusIndex((f) => Math.min(5, f + 1))
      }
      return
    }
    if (extendedKey.return) {
      if (focusIndex === 4) {
        setSaving(true)
        setError(null)
        onRemoveApiKey()
          .then(() => onClose({ saved: true }))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      } else if (focusIndex === 5) {
        doSave()
      } else {
        setFocusIndex((f) => Math.min(5, f + 1))
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
          {focusIndex === 2 ? figures.pointer : ' '} Base URL:{' '}
        </Text>
        <Text>{focusIndex === 2 ? baseUrlField.renderedValue : (baseUrl || '(provider default)')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={focusIndex === 3 ? theme.primary : undefined}>
          {focusIndex === 3 ? figures.pointer : ' '} API key:{' '}
        </Text>
        <Text>{focusIndex === 3 ? apiKeyField.renderedValue : (apiKey ? '•'.repeat(apiKey.length) : '(blank keeps stored key)')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={focusIndex === 4 ? theme.primary : undefined}>
          {focusIndex === 4 ? figures.pointer : ' '}{' '}
          <Text bold>{saving ? 'Working…' : 'Remove stored API key'}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={focusIndex === 5 ? theme.primary : undefined}>
          {focusIndex === 5 ? figures.pointer : ' '}{' '}
          <Text bold>{saving ? 'Saving…' : 'Save'}</Text>
        </Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ Tab navigate · Enter next/action · blank key keeps stored · Esc close</Text>
      </Box>
    </Box>
  )
}
