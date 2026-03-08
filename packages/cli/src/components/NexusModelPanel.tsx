import { Box, Text, useInput } from 'ink'
import React, { useMemo, useRef, useState } from 'react'
import chalk from 'chalk'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, ProviderConfig } from '@nexuscode/core'
import { catalogSelectionToModel } from '@nexuscode/core'
import type { ModelsCatalog } from '@nexuscode/core'
import { useFieldInput } from '../hooks/useFieldInput.js'

const NEXUS_GATEWAY = 'https://api.kilo.ai/api/gateway'
const VISIBLE_ROWS = 10
const FREE_TOP = 10

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

type Screen = 'root' | 'free' | 'free-search' | 'own'

export function NexusModelPanel({
  initialConfig,
  catalog,
  catalogError,
  onSave,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [screen, setScreen] = useState<Screen>('root')
  const [rootIndex, setRootIndex] = useState(0)
  const [freeIndex, setFreeIndex] = useState(0)
  const [freeSearchQuery, setFreeSearchQuery] = useState('')
  const [freeSearchSelected, setFreeSearchSelected] = useState(0)
  const [ownFieldIndex, setOwnFieldIndex] = useState(0)
  const [ownProvider, setOwnProvider] = useState(initialConfig.model?.provider ?? 'openai-compatible')
  const [ownBaseUrl, setOwnBaseUrl] = useState(initialConfig.model?.baseUrl ?? '')
  const [ownApiKey, setOwnApiKey] = useState(initialConfig.model?.apiKey ?? '')
  const [ownModelId, setOwnModelId] = useState(initialConfig.model?.id ?? '')
  const [ownTemperature, setOwnTemperature] = useState(
    String(initialConfig.model?.temperature ?? ''),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invert = chalk.inverse
  const baseUrlField = useFieldInput(ownBaseUrl, setOwnBaseUrl, invert)
  const apiKeyField = useFieldInput(ownApiKey, setOwnApiKey, invert, { maskChar: '•' })
  const modelIdField = useFieldInput(ownModelId, setOwnModelId, invert)
  const temperatureField = useFieldInput(ownTemperature, setOwnTemperature, invert)

  /** Refs for selected index so Enter uses latest value after scroll (avoids stale closure on Mac/fast key presses) */
  const freeIndexRef = useRef(0)
  const freeSearchSelectedRef = useRef(0)
  freeIndexRef.current = freeIndex
  freeSearchSelectedRef.current = freeSearchSelected

  const currentId = initialConfig.model?.id ?? '—'

  const freeModels = useMemo(() => {
    if (!catalog) return []
    return catalog.recommended.filter((r) => r.free)
  }, [catalog])

  const freeTop = useMemo(() => freeModels.slice(0, FREE_TOP), [freeModels])
  const freeSearchResults = useMemo(() => {
    if (!freeSearchQuery.trim()) return freeModels
    const q = freeSearchQuery.toLowerCase()
    return freeModels.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.modelId.toLowerCase().includes(q),
    )
  }, [freeModels, freeSearchQuery])

  const goBack = () => {
    if (screen === 'root') {
      onClose({ cancelled: true })
      return
    }
    if (screen === 'free' || screen === 'own') {
      setScreen('root')
      return
    }
    if (screen === 'free-search') {
      setScreen('free')
      setFreeSearchQuery('')
      setFreeSearchSelected(0)
      return
    }
  }

  /** Treat Enter key: some terminals send \r or \n instead of key.return */
  const isEnter = (key: { return?: boolean }, input: string) =>
    key.return || input === '\r' || input === '\n'

  useInput((input, key) => {
    if (key.escape) {
      goBack()
      return
    }

    if (screen === 'root') {
      if (key.upArrow) setRootIndex((i) => (i === 0 ? 1 : 0))
      if (key.downArrow) setRootIndex((i) => (i === 1 ? 0 : 1))
      if (isEnter(key, input ?? '') || input === ' ') {
        if (rootIndex === 0) {
          setScreen('free')
          setFreeIndex(0)
        } else {
          setScreen('own')
          setOwnFieldIndex(0)
        }
      }
      return
    }

    if (screen === 'free') {
      const freeListWithSearch = [...freeTop.map((r) => ({ ...r, key: `${r.providerId}:${r.modelId}` })), { key: '__search__', label: 'Search free models…', providerId: '', modelId: '' }]
      if (key.upArrow) {
        const next = Math.max(0, freeIndex - 1)
        freeIndexRef.current = next
        setFreeIndex(next)
      }
      if (key.downArrow) {
        const next = Math.min(freeListWithSearch.length - 1, freeIndex + 1)
        freeIndexRef.current = next
        setFreeIndex(next)
      }
      if (isEnter(key, input ?? '') || input === ' ') {
        const idx = freeIndexRef.current
        const item = freeListWithSearch[idx]
        if (item && item.key === '__search__') {
          setScreen('free-search')
          setFreeSearchSelected(0)
          freeSearchSelectedRef.current = 0
          return
        }
        const r = idx < freeTop.length ? freeTop[idx] : null
        if (r && catalog) {
          setSaving(true)
          setError(null)
          const resolved = catalogSelectionToModel(r.providerId, r.modelId, catalog)
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
      }
      return
    }

    if (screen === 'free-search') {
      if (key.backspace || input === '\x7f' || key.delete) {
        setFreeSearchQuery((s) => s.slice(0, -1))
        return
      }
      if (input != null && input !== '' && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setFreeSearchQuery((s) => s + input.replace(/\r\n?/g, ' ').replace(/\r/g, ' '))
        setFreeSearchSelected(0)
        freeSearchSelectedRef.current = 0
        return
      }
      const list = freeSearchResults
      if (key.upArrow) {
        const next = Math.max(0, freeSearchSelected - 1)
        freeSearchSelectedRef.current = next
        setFreeSearchSelected(next)
      }
      if (key.downArrow) {
        const next = Math.min(list.length - 1, freeSearchSelected + 1)
        freeSearchSelectedRef.current = next
        setFreeSearchSelected(next)
      }
      if (isEnter(key, input ?? '') || input === ' ') {
        const r = list[freeSearchSelectedRef.current]
        if (r && catalog) {
          setSaving(true)
          setError(null)
          const resolved = catalogSelectionToModel(r.providerId, r.modelId, catalog)
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
      }
      return
    }

    if (screen === 'own') {
      const fieldCount = 5
      if (ownFieldIndex === 0) {
        if (key.upArrow) {
          const idx = PROVIDER_OPTIONS.findIndex((p) => p.id === ownProvider)
          setOwnProvider(PROVIDER_OPTIONS[(idx - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length].id)
          return
        }
        if (key.downArrow) {
          const idx = PROVIDER_OPTIONS.findIndex((p) => p.id === ownProvider)
          setOwnProvider(PROVIDER_OPTIONS[(idx + 1) % PROVIDER_OPTIONS.length].id)
          return
        }
      }
      if (key.upArrow && ownFieldIndex > 0) setOwnFieldIndex((i) => Math.max(0, i - 1))
      if (key.downArrow) setOwnFieldIndex((i) => Math.min(fieldCount - 1, i + 1))
      if (key.tab) setOwnFieldIndex((i) => (i + 1) % fieldCount)
      if (key.backtab) setOwnFieldIndex((i) => (i - 1 + fieldCount) % fieldCount)

      if (ownFieldIndex >= 1 && ownFieldIndex <= 4) {
        const handlers = [baseUrlField.handleInput, apiKeyField.handleInput, modelIdField.handleInput, temperatureField.handleInput]
        if (handlers[ownFieldIndex - 1](input ?? '', key)) return
      }

      if (isEnter(key, input ?? '')) {
        const provider = ownProvider
        const baseUrl = ownBaseUrl.trim() || (provider === 'openai-compatible' ? NEXUS_GATEWAY : undefined)
        const id = ownModelId.trim()
        if (!id) {
          setError('Model ID is required')
          return
        }
        const temp = ownTemperature.trim() ? parseFloat(ownTemperature) : undefined
        if (ownTemperature.trim() && (Number.isNaN(temp) || temp < 0 || temp > 2)) {
          setError('Temperature must be 0–2')
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

  if (screen === 'root') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={8}>
        <Box marginBottom={1}>
          <Text bold>Model</Text>
          <Text dimColor> · Current: {currentId}</Text>
        </Box>
        <Box flexDirection="column" height={4}>
          {['Free models (top + search)', 'Own (provider, URL, key, model, temperature)'].map((label, i) => (
            <Box key={label} height={1}>
              <Text color={i === rootIndex ? theme.primary : undefined}>
                {i === rootIndex ? figures.pointer : ' '} {label}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · Enter open · Esc close</Text>
        </Box>
      </Box>
    )
  }

  if (screen === 'free') {
    const items = freeTop.map((r) => ({
      key: `${r.providerId}:${r.modelId}`,
      label: r.name,
      providerId: r.providerId,
      modelId: r.modelId,
    }))
    items.push({ key: '__search__', label: 'Search free models…', providerId: '', modelId: '' })
    const scrollStart = Math.max(0, Math.min(freeIndex, items.length - VISIBLE_ROWS))
    const visibleItems = items.slice(scrollStart, scrollStart + VISIBLE_ROWS)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={VISIBLE_ROWS + 6}>
        <Box marginBottom={1}>
          <Text bold>Free models</Text>
        </Box>
        {catalogError && (
          <Box marginBottom={1}>
            <Text color={theme.warning}>{catalogError}</Text>
          </Box>
        )}
        <Box flexDirection="column" height={VISIBLE_ROWS}>
          {visibleItems.map((item, i) => {
            const globalIndex = scrollStart + i
            const isSelected = globalIndex === freeIndex
            return (
              <Box key={item.key} height={1}>
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? figures.pointer : ' '} {item.label}
                </Text>
              </Box>
            )
          })}
        </Box>
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

  if (screen === 'free-search') {
    const list = freeSearchResults
    const scrollStart = Math.max(0, Math.min(freeSearchSelected, list.length - VISIBLE_ROWS))
    const visible = list.slice(scrollStart, scrollStart + VISIBLE_ROWS)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={VISIBLE_ROWS + 8}>
        <Box marginBottom={1}>
          <Text bold>Search free models</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color={theme.primary}>Query: </Text>
          <Text>{freeSearchQuery}</Text>
          <Text color={theme.secondaryText}>|</Text>
        </Box>
        <Box flexDirection="column" height={VISIBLE_ROWS}>
          {visible.map((r, i) => {
            const globalIndex = scrollStart + i
            const isSelected = globalIndex === freeSearchSelected
            return (
              <Box key={`${r.providerId}:${r.modelId}`} height={1}>
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? figures.pointer : ' '} {r.name}
                </Text>
              </Box>
            )
          })}
        </Box>
        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Type to search · ↑/↓ select · Enter choose · Esc back</Text>
        </Box>
      </Box>
    )
  }

  if (screen === 'own') {
    const fieldDisplays = [
      PROVIDER_OPTIONS.find((p) => p.id === ownProvider)?.label ?? ownProvider,
      ownFieldIndex === 1 ? baseUrlField.renderedValue : (ownBaseUrl || '(optional for some)'),
      ownFieldIndex === 2 ? apiKeyField.renderedValue : (ownApiKey ? '•'.repeat(ownApiKey.length) : '(optional)'),
      ownFieldIndex === 3 ? modelIdField.renderedValue : (ownModelId || ''),
      ownFieldIndex === 4 ? temperatureField.renderedValue : (ownTemperature || ''),
    ]
    const fieldNames = ['Provider', 'Base URL', 'API key', 'Model ID', 'Temperature (0–2)']
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1} marginTop={1} height={14}>
        <Box marginBottom={1}>
          <Text bold>Own model</Text>
        </Box>
        <Box flexDirection="column" height={6}>
          {fieldNames.map((name, i) => (
            <Box key={name} height={1}>
              <Text color={i === ownFieldIndex ? theme.primary : undefined}>
                {i === ownFieldIndex ? figures.pointer : ' '} {name}:{' '}
              </Text>
              <Text>{fieldDisplays[i] ?? '—'}</Text>
            </Box>
          ))}
        </Box>
        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ or Tab field · type value · Enter save · Esc back</Text>
        </Box>
      </Box>
    )
  }

  return null
}
