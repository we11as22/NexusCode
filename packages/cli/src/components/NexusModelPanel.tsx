import { Box, Text, useInput } from 'ink'
import React, { useMemo, useRef, useState } from 'react'
import chalk from 'chalk'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, ProviderConfig } from '@nexuscode/core'
import { catalogSelectionToModel } from '@nexuscode/core'
import type { ModelsCatalog } from '@nexuscode/core'
import { useFieldInput } from '../hooks/useFieldInput.js'

const NEXUS_GATEWAY = 'https://api.kilo.ai/api/openrouter'
const VISIBLE_ROWS = 12

const PROVIDER_OPTIONS: { id: ProviderConfig['provider']; label: string }[] = [
  { id: 'openai-compatible', label: 'OpenAI-compatible (URL + key)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'groq', label: 'Groq' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepinfra', label: 'DeepInfra' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'cohere', label: 'Cohere' },
  { id: 'togetherai', label: 'Together AI' },
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'azure', label: 'Azure OpenAI' },
  { id: 'bedrock', label: 'AWS Bedrock' },
]

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  cwd: string
  initialConfig: NexusConfig
  catalog: ModelsCatalog | null
  catalogError: string | null
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: (result?: CloseResult) => void
}

/** Provider row for the first screen */
type ProviderItem = { key: string; id: string; name: string }
/** Model row for the second screen (after picking a provider) */
type ModelItem = { key: string; modelId: string; name: string; free: boolean }

export function NexusModelPanel({
  initialConfig,
  catalog,
  catalogError,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [screen, setScreen] = useState<'providers' | 'models' | 'custom'>('providers')
  const [providerIndex, setProviderIndex] = useState(0)
  const [modelIndex, setModelIndex] = useState(0)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [ownFieldIndex, setOwnFieldIndex] = useState(0)
  const [ownProvider, setOwnProvider] = useState(initialConfig.model?.provider ?? 'openai-compatible')
  const [ownBaseUrl, setOwnBaseUrl] = useState(initialConfig.model?.baseUrl ?? '')
  const [ownApiKey, setOwnApiKey] = useState(initialConfig.model?.apiKey ?? '')
  const [ownModelId, setOwnModelId] = useState(initialConfig.model?.id ?? '')
  const [ownTemperature, setOwnTemperature] = useState(
    String(initialConfig.model?.temperature ?? ''),
  )
  const [ownReasoningEffort, setOwnReasoningEffort] = useState(
    String(initialConfig.model?.reasoningEffort ?? ''),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invert = chalk.inverse
  const baseUrlField = useFieldInput(ownBaseUrl, setOwnBaseUrl, invert)
  const apiKeyField = useFieldInput(ownApiKey, setOwnApiKey, invert, { maskChar: '•' })
  const modelIdField = useFieldInput(ownModelId, setOwnModelId, invert)
  const temperatureField = useFieldInput(ownTemperature, setOwnTemperature, invert)
  const reasoningEffortField = useFieldInput(ownReasoningEffort, setOwnReasoningEffort, invert)

  const providerIndexRef = useRef(0)
  providerIndexRef.current = providerIndex
  const modelIndexRef = useRef(0)
  modelIndexRef.current = modelIndex

  const currentId = initialConfig.model?.id ?? '—'

  /** Step 1: list of providers from catalog + "Custom model…" */
  const providerOptions = useMemo((): ProviderItem[] => {
    const out: ProviderItem[] = []
    if (catalog) {
      for (const p of catalog.providers) {
        out.push({ key: p.id, id: p.id, name: p.name })
      }
    }
    out.push({ key: '__custom__', id: '__custom__', name: 'Custom model…' })
    return out
  }, [catalog])

  /** Step 2: models for the selected provider (free first) */
  const modelOptions = useMemo((): ModelItem[] => {
    if (!selectedProviderId || selectedProviderId === '__custom__' || !catalog) return []
    const prov = catalog.providers.find((p) => p.id === selectedProviderId)
    if (!prov) return []
    const list: ModelItem[] = prov.models.map((m) => ({
      key: m.id,
      modelId: m.id,
      name: m.name,
      free: m.free,
    }))
    list.sort((a, b) => (a.free !== b.free ? (a.free ? -1 : 1) : a.name.localeCompare(b.name)))
    return list
  }, [catalog, selectedProviderId])

  const goBack = () => {
    if (screen === 'providers') {
      onClose({ cancelled: true })
      return
    }
    if (screen === 'models' || screen === 'custom') {
      setScreen('providers')
      setSelectedProviderId(null)
      setProviderIndex(0)
      setModelIndex(0)
      setError(null)
    }
  }

  const isEnter = (key: { return?: boolean }, input: string) =>
    key.return || input === '\r' || input === '\n'

  useInput((input, key) => {
    if (key.escape) {
      goBack()
      return
    }

    if (screen === 'providers') {
      const list = providerOptions
      if (key.upArrow) {
        setProviderIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setProviderIndex((i) => Math.min(list.length - 1, i + 1))
        return
      }
      if (isEnter(key, input ?? '')) {
        const item = list[providerIndexRef.current]
        if (!item) return
        if (item.id === '__custom__') {
          setScreen('custom')
          return
        }
        setSelectedProviderId(item.id)
        setModelIndex(0)
        setScreen('models')
      }
      return
    }

    if (screen === 'models') {
      const list = modelOptions
      if (key.upArrow) {
        setModelIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setModelIndex((i) => Math.min(list.length - 1, i + 1))
        return
      }
      if (isEnter(key, input ?? '')) {
        const item = list[modelIndexRef.current]
        if (!item || !catalog || !selectedProviderId) return
        setSaving(true)
        setError(null)
        const resolved = catalogSelectionToModel(selectedProviderId, item.modelId, catalog)
        onSave({
          model: {
            provider: resolved.provider as ProviderConfig['provider'],
            id: resolved.id,
            baseUrl: resolved.baseUrl,
          } as ProviderConfig,
        })
          .then(() => onClose({ saved: true }))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      }
      return
    }

    if (screen === 'custom') {
      // fieldCount = 7: 0=Provider, 1=BaseURL, 2=APIKey, 3=ModelID, 4=Temp, 5=ReasoningEffort, 6=Save
      const fieldCount = 7

      // On text fields (1-5): let field handle input first, THEN check navigation
      if (ownFieldIndex >= 1 && ownFieldIndex <= 5) {
        const handlers = [
          baseUrlField.handleInput,
          apiKeyField.handleInput,
          modelIdField.handleInput,
          temperatureField.handleInput,
          reasoningEffortField.handleInput,
        ]
        if (handlers[ownFieldIndex - 1]!(input ?? '', key)) return
      }

      if (key.tab) {
        setOwnFieldIndex((i) => (i + 1) % fieldCount)
        return
      }
      if (key.backtab) {
        setOwnFieldIndex((i) => (i - 1 + fieldCount) % fieldCount)
        return
      }
      if (key.upArrow) {
        if (ownFieldIndex === 0) {
          const idx = PROVIDER_OPTIONS.findIndex((p) => p.id === ownProvider)
          setOwnProvider(PROVIDER_OPTIONS[(idx - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length]!.id)
        } else {
          setOwnFieldIndex((i) => Math.max(0, i - 1))
        }
        return
      }
      if (key.downArrow) {
        if (ownFieldIndex === 0) {
          const idx = PROVIDER_OPTIONS.findIndex((p) => p.id === ownProvider)
          setOwnProvider(PROVIDER_OPTIONS[(idx + 1) % PROVIDER_OPTIONS.length]!.id)
        } else {
          setOwnFieldIndex((i) => Math.min(fieldCount - 1, i + 1))
        }
        return
      }
      if (isEnter(key, input ?? '')) {
        if (ownFieldIndex < fieldCount - 1) {
          // Enter on a field moves to next field
          setOwnFieldIndex((i) => Math.min(fieldCount - 1, i + 1))
          return
        }
        // Enter on Save button
        const provider = ownProvider
        const baseUrl = ownBaseUrl.trim() || (provider === 'openai-compatible' ? NEXUS_GATEWAY : undefined)
        const id = ownModelId.trim()
        if (!id) {
          setError('Model ID is required')
          setOwnFieldIndex(3)
          return
        }
        const temp = ownTemperature.trim() ? parseFloat(ownTemperature) : undefined
        if (ownTemperature.trim() && (Number.isNaN(temp) || temp! < 0 || temp! > 2)) {
          setError('Temperature must be 0–2')
          setOwnFieldIndex(4)
          return
        }
        setSaving(true)
        setError(null)
        onSave({
          model: {
            provider,
            id,
            baseUrl: baseUrl || undefined,
            ...(ownApiKey.trim() ? { apiKey: ownApiKey.trim() } : {}),
            temperature: temp,
            reasoningEffort: ownReasoningEffort.trim() || undefined,
          } as ProviderConfig,
        })
          .then(() => onClose({ saved: true }))
          .catch((e) => {
            setError(String(e))
            setSaving(false)
          })
      }
      return
    }
  })

  // --- Custom model form (step 2b)
  if (screen === 'custom') {
    const fieldDisplays = [
      PROVIDER_OPTIONS.find((p) => p.id === ownProvider)?.label ?? ownProvider,
      ownFieldIndex === 1 ? baseUrlField.renderedValue : (ownBaseUrl || '(optional)'),
      ownFieldIndex === 2 ? apiKeyField.renderedValue : (ownApiKey ? '•'.repeat(ownApiKey.length) : '(optional)'),
      ownFieldIndex === 3 ? modelIdField.renderedValue : (ownModelId || '(required)'),
      ownFieldIndex === 4 ? temperatureField.renderedValue : (ownTemperature || '(auto)'),
      ownFieldIndex === 5 ? reasoningEffortField.renderedValue : (ownReasoningEffort || '(auto)'),
    ]
    const fieldNames = ['Provider', 'Base URL', 'API key', 'Model ID', 'Temperature (0–2)', 'Reasoning effort']
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1}>
        <Box marginBottom={1}>
          <Text bold>Custom model</Text>
          <Text dimColor> · Esc back</Text>
        </Box>
        <Box flexDirection="column">
          {fieldNames.map((name, i) => (
            <Box key={name}>
              <Text color={i === ownFieldIndex ? theme.primary : undefined}>
                {i === ownFieldIndex ? figures.pointer : ' '} {name}:{' '}
              </Text>
              <Text>{fieldDisplays[i] ?? '—'}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color={ownFieldIndex === 6 ? theme.primary : undefined}>
              {ownFieldIndex === 6 ? figures.pointer : ' '}{' '}
              <Text bold>{saving ? 'Saving…' : 'Save'}</Text>
            </Text>
          </Box>
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ Tab navigate · type in field · Enter next/save · Esc back</Text>
        </Box>
      </Box>
    )
  }

  // --- Models list (step 2a: after picking a provider)
  if (screen === 'models') {
    const list = modelOptions
    const provName = catalog?.providers.find((p) => p.id === selectedProviderId)?.name ?? selectedProviderId ?? ''
    const scrollStart = Math.max(0, Math.min(modelIndex, list.length - VISIBLE_ROWS))
    const visibleItems = list.slice(scrollStart, scrollStart + VISIBLE_ROWS)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={VISIBLE_ROWS + 7}>
        <Box marginBottom={1}>
          <Text bold>{provName}</Text>
          <Text dimColor> · Esc back</Text>
        </Box>
        {list.length === 0 ? (
          <Box height={VISIBLE_ROWS}>
            <Text dimColor>No models</Text>
          </Box>
        ) : (
          <Box flexDirection="column" height={VISIBLE_ROWS}>
            {visibleItems.map((item, i) => {
              const globalIndex = scrollStart + i
              const isSelected = globalIndex === modelIndex
              const freeTag = item.free ? ' Free' : ''
              return (
                <Box key={item.key} height={1}>
                  <Text color={isSelected ? theme.primary : undefined}>
                    {isSelected ? figures.pointer : ' '} {item.name}
                    {freeTag ? <Text color={theme.secondaryText}>{freeTag}</Text> : null}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · Enter choose · Esc back</Text>
        </Box>
      </Box>
    )
  }

  // --- Step 1: Provider list
  const list = providerOptions
  const scrollStart = Math.max(0, Math.min(providerIndex, list.length - VISIBLE_ROWS))
  const visibleItems = list.slice(scrollStart, scrollStart + VISIBLE_ROWS)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={VISIBLE_ROWS + 7}>
      <Box marginBottom={1}>
        <Text bold>Select model</Text>
        <Text dimColor> · Current: {currentId}</Text>
      </Box>
      {catalogError && (
        <Box marginBottom={1}>
          <Text color={theme.warning}>{catalogError}</Text>
        </Box>
      )}
      <Box flexDirection="column" height={VISIBLE_ROWS}>
        {visibleItems.map((item, i) => {
          const globalIndex = scrollStart + i
          const isSelected = globalIndex === providerIndex
          return (
            <Box key={item.key} height={1}>
              <Text color={isSelected ? theme.primary : undefined}>
                {isSelected ? figures.pointer : ' '} {item.name}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · Enter choose · Esc close</Text>
      </Box>
    </Box>
  )
}
