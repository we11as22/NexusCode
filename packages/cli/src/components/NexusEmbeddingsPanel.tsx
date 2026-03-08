import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, EmbeddingConfig } from '@nexuscode/core'

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

type Props = {
  initialConfig: NexusConfig
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: () => void
}

export function NexusEmbeddingsPanel({
  initialConfig,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const emb = initialConfig.embeddings
  const [providerIndex, setProviderIndex] = useState(() => {
    const id = emb?.provider ?? 'openai-compatible'
    const i = EMBEDDING_PROVIDERS.findIndex((p) => p.id === id)
    return i >= 0 ? i : 0
  })
  const [modelId, setModelId] = useState(emb?.model ?? '')
  const [focus, setFocus] = useState<'provider' | 'model' | 'save'>('provider')
  const [customMode, setCustomMode] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentProvider = EMBEDDING_PROVIDERS[providerIndex]
  const providerId = currentProvider?.id ?? 'openai-compatible'

  const doSave = () => {
    if (!modelId.trim()) {
      setError('Model ID is required')
      return
    }
    setSaving(true)
    setError(null)
    const config: EmbeddingConfig = {
      provider: providerId,
      model: modelId.trim(),
    }
    onSave({ embeddings: config })
      .then(() => onClose())
      .catch((e) => {
        setError(String(e))
        setSaving(false)
      })
  }

  useInput((input, key) => {
    if (customMode) {
      if (key.escape) {
        setCustomMode(false)
        setCustomInput('')
        return
      }
      if (key.return) {
        const value = customInput.trim()
        if (focus === 'provider') {
          const p = EMBEDDING_PROVIDERS.find((x) => x.id === value || x.label === value)
          if (p) setProviderIndex(EMBEDDING_PROVIDERS.indexOf(p))
        } else {
          setModelId(value)
        }
        setCustomMode(false)
        setCustomInput('')
        return
      }
      if (key.backspace || input === '\x7f' || key.delete) {
        setCustomInput((s) => s.slice(0, -1))
        return
      }
      if (input != null && input !== '') {
        setCustomInput((s) => s + input.replace(/\r\n?/g, ' ').replace(/\r/g, ' '))
      }
      return
    }

    if (key.escape) {
      onClose()
      return
    }
    if (key.tab) {
      setFocus((f) => (f === 'provider' ? 'model' : f === 'model' ? 'save' : 'provider'))
      return
    }
    if (key.upArrow) {
      if (focus === 'provider') {
        setProviderIndex((prev) => Math.max(0, prev - 1))
      }
      return
    }
    if (key.downArrow) {
      if (focus === 'provider') {
        setProviderIndex((prev) => Math.min(EMBEDDING_PROVIDERS.length - 1, prev + 1))
      }
      return
    }
    if (key.return || input === ' ') {
      if (focus === 'save') {
        doSave()
        return
      }
      if (focus === 'model' && input !== ' ') {
        setCustomMode(true)
        setCustomInput(modelId)
        return
      }
      if (focus === 'provider') {
        setFocus('model')
        return
      }
      if (focus === 'model') {
        setCustomMode(true)
        setCustomInput(modelId)
      }
    }
  })

  if (customMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
        <Box marginBottom={1}>
          <Text bold>Embeddings — {focus === 'provider' ? 'Provider' : 'Model ID'}</Text>
        </Box>
        <Box>
          <Text color={theme.primary}>
            {focus === 'provider' ? 'Provider (e.g. openai-compatible): ' : 'Model (e.g. text-embedding-3-small): '}
          </Text>
          <Text>{customInput}</Text>
          <Text color={theme.secondaryText}>|</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter value · Enter to apply · Esc to cancel</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>Embeddings</Text>
        <Text dimColor>
          Current: {emb ? `${emb.provider} / ${emb.model}` : 'not set'}
        </Text>
      </Box>
      <Box height={2}>
        <Text color={focus === 'provider' ? theme.primary : undefined}>
          {focus === 'provider' ? figures.pointer : ' '} Provider:{' '}
        </Text>
        <Text>{currentProvider?.label ?? providerId}</Text>
      </Box>
      <Box height={2}>
        <Text color={focus === 'model' ? theme.primary : undefined}>
          {focus === 'model' ? figures.pointer : ' '} Model:{' '}
        </Text>
        <Text>{modelId || '—'}</Text>
      </Box>
      <Box height={2}>
        <Text color={focus === 'save' ? theme.primary : undefined}>
          {focus === 'save' ? figures.pointer : ' '} Save and close
        </Text>
      </Box>
      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Tab switch field · ↑/↓ provider · Enter edit/Save · Esc close</Text>
      </Box>
    </Box>
  )
}
