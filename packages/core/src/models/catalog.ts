/**
 * Models catalog from models.dev.
 * Used by CLI and extension to show "Select model" with Recommended / free models.
 * Free models (cost.input === 0) are sorted first so users can start without an API key (OpenRouter free tier).
 */

const DEFAULT_MODELS_URL = "https://models.dev/api.json"
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const NEXUS_GATEWAY_BASE_URL = "https://api.kilo.ai/api/openrouter"
const SOURCE_TIMEOUT_MS = 15_000

export interface CatalogModel {
  id: string
  name: string
  /** Zero-cost / free tier */
  free: boolean
  /** Provider-advertised total context window in tokens. */
  contextWindow?: number
  /** Provider-advertised maximum completion size in tokens. */
  maxOutputTokens?: number
  /** Optional sort order for recommended (lower first) */
  recommendedIndex?: number
}

export interface CatalogProvider {
  id: string
  name: string
  baseUrl: string
  /** Nexus uses openai-compatible with this baseUrl */
  models: CatalogModel[]
}

export interface ModelsCatalog {
  providers: CatalogProvider[]
  /** Flat list: free models first (Recommended), then rest */
  recommended: Array<{
    providerId: string
    modelId: string
    name: string
    free: boolean
    contextWindow?: number
    maxOutputTokens?: number
  }>
}

interface NexusGatewayModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  free?: boolean
}

interface NexusGatewayModelsResponse {
  data?: Array<{
    id?: unknown
    name?: unknown
    context_length?: unknown
    top_provider?: {
      context_length?: unknown
      max_completion_tokens?: unknown
    }
    pricing?: {
      prompt?: unknown
      completion?: unknown
    }
  }>
}

let cachedCatalog: ModelsCatalog | null = null
let cachedAt = 0
const CACHE_MS = 10 * 60 * 1000 // 10 min

function isSupportedProvider(providerKey: string, p: { api?: string }): boolean {
  const key = providerKey.toLowerCase()
  if (key === "openrouter" || key === "kilo" || key === "nexus") return true
  const api = (p.api ?? "").toLowerCase()
  return api.includes("openrouter.ai") || api.includes("api.kilo.ai") || api.includes("api.nexus")
}

function isFreeModel(m: { cost?: { input?: number } }): boolean {
  const input = m.cost?.input
  return typeof input === "number" && input === 0
}

export function getModelsUrl(): string {
  return process.env.NEXUS_MODELS_URL ?? process.env.KILO_MODELS_URL ?? DEFAULT_MODELS_URL
}

export function getModelsPath(): string | undefined {
  return process.env.NEXUS_MODELS_PATH ?? process.env.OPENCODE_MODELS_PATH ?? process.env.KILO_MODELS_PATH
}

/**
 * Load catalog from all available sources with 15s timeout per source.
 * Uses only sources that respond in time; results are merged and deduplicated by (providerId, modelId).
 */
export async function getModelsCatalog(): Promise<ModelsCatalog> {
  const now = Date.now()
  if (cachedCatalog && now - cachedAt < CACHE_MS) {
    return cachedCatalog
  }

  const path = getModelsPath()
  const url = getModelsUrl()

  const fetchUrl = (): Promise<Record<string, unknown>> =>
    fetch(url, {
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    }).then((res) => {
      if (!res.ok) throw new Error(`fetch: ${res.status}`)
      return res.json() as Promise<Record<string, unknown>>
    })

  const readPath = (): Promise<Record<string, unknown> | null> => {
    if (!path) return Promise.resolve(null)
    const read = import("node:fs/promises")
      .then((fs) => fs.readFile(path, "utf8"))
      .then((content) => JSON.parse(content) as Record<string, unknown>)
    return Promise.race([
      read,
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), SOURCE_TIMEOUT_MS)
      ),
    ]).then((data) => data, () => null)
  }

  const [gatewaySettled, urlSettled, pathSettled] = await Promise.allSettled([
    getNexusGatewayModels(),
    fetchUrl(),
    readPath(),
  ])

  const gatewayModels =
    gatewaySettled.status === "fulfilled" ? gatewaySettled.value : null

  const rawDataSources: Record<string, unknown>[] = []
  if (urlSettled.status === "fulfilled") rawDataSources.push(urlSettled.value)
  if (pathSettled.status === "fulfilled" && pathSettled.value)
    rawDataSources.push(pathSettled.value)

  if (rawDataSources.length === 0 && !gatewayModels?.size) {
    cachedCatalog = getFallbackCatalog()
    cachedAt = now
    return cachedCatalog
  }

  const catalogs =
    rawDataSources.length > 0
      ? rawDataSources.map((data) => parseCatalog(data, gatewayModels))
      : [parseCatalog({}, gatewayModels)]
  cachedCatalog = mergeCatalogs(catalogs)
  cachedAt = now
  return cachedCatalog
}

/** Merge multiple catalogs: deduplicate by (providerId, modelId), first occurrence wins */
function mergeCatalogs(catalogs: ModelsCatalog[]): ModelsCatalog {
  const providersById = new Map<string, CatalogProvider>()
  const recommendedKeys = new Set<string>()

  for (const cat of catalogs) {
    for (const prov of cat.providers) {
      const existing = providersById.get(prov.id)
      if (!existing) {
        providersById.set(prov.id, { ...prov, models: [...prov.models] })
      } else {
        const modelIds = new Set(existing.models.map((m) => m.id))
        for (const m of prov.models) {
          if (!modelIds.has(m.id)) {
            modelIds.add(m.id)
            existing.models.push(m)
          }
        }
        existing.models.sort((a, b) => {
          if (a.free !== b.free) return a.free ? -1 : 1
          const ra = a.recommendedIndex ?? 9999
          const rb = b.recommendedIndex ?? 9999
          if (ra !== rb) return ra - rb
          return a.name.localeCompare(b.name)
        })
      }
    }
  }

  const providers = Array.from(providersById.values())
  const recommended: ModelsCatalog["recommended"] = []

  for (const cat of catalogs) {
    for (const r of cat.recommended) {
      const key = `${r.providerId}:${r.modelId}`
      if (recommendedKeys.has(key)) continue
      recommendedKeys.add(key)
      recommended.push(r)
    }
  }

  recommended.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1
    if (a.providerId !== b.providerId) {
      if (a.providerId === "nexus") return -1
      if (b.providerId === "nexus") return 1
    }
    return a.name.localeCompare(b.name)
  })

  return { providers, recommended }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function zeroPrice(value: unknown): boolean {
  if (typeof value === "number") return value === 0
  return typeof value === "string" && value.trim() !== "" && Number(value) === 0
}

function parseNexusGatewayModels(
  json: NexusGatewayModelsResponse,
): Map<string, NexusGatewayModel> | null {
  const models = new Map<string, NexusGatewayModel>()
  for (const raw of json.data ?? []) {
    if (typeof raw?.id !== "string" || raw.id.trim() === "") continue
    const contextWindow =
      positiveInteger(raw.context_length) ??
      positiveInteger(raw.top_provider?.context_length)
    const maxOutputTokens = positiveInteger(
      raw.top_provider?.max_completion_tokens,
    )
    const free =
      raw.id.endsWith("/free") ||
      (zeroPrice(raw.pricing?.prompt) && zeroPrice(raw.pricing?.completion))
    models.set(raw.id, {
      id: raw.id,
      ...(typeof raw.name === "string" && raw.name.trim()
        ? { name: raw.name }
        : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(free ? { free: true } : {}),
    })
  }
  return models.size > 0 ? models : null
}

async function getNexusGatewayModels(): Promise<Map<string, NexusGatewayModel> | null> {
  try {
    const res = await fetch(`${NEXUS_GATEWAY_BASE_URL}/models`, {
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: "Bearer dummy",
      },
    })
    if (!res.ok) return null
    return parseNexusGatewayModels(
      (await res.json()) as NexusGatewayModelsResponse,
    )
  } catch {
    return null
  }
}

export function parseCatalogData(
  data: Record<string, unknown>,
  gatewayResponse?: NexusGatewayModelsResponse,
): ModelsCatalog {
  return parseCatalog(data, parseNexusGatewayModels(gatewayResponse ?? {}))
}

function parseCatalog(
  data: Record<string, unknown>,
  gatewayModels: Map<string, NexusGatewayModel> | null,
): ModelsCatalog {
  const providers: CatalogProvider[] = []
  const recommended: ModelsCatalog["recommended"] = []

  const rawProviders = data as Record<string, {
    id?: string
    name?: string
    api?: string
    models?: Record<string, {
      id?: string
      name?: string
      cost?: { input?: number }
      limit?: { context?: number }
      recommendedIndex?: number
    }>
  }>
  for (const [providerKey, prov] of Object.entries(rawProviders)) {
    if (!prov || typeof prov !== "object" || !prov.models) continue
    if (!isSupportedProvider(providerKey, prov)) continue
    const providerId = providerKey === "kilo" ? "nexus" : providerKey
    const api = prov.api ?? ""

    const baseUrl =
      providerId === "nexus"
        ? NEXUS_GATEWAY_BASE_URL
        : api.trim() || OPENROUTER_BASE_URL
    const name = providerId === "nexus" ? "Nexus Gateway" : (prov.name ?? providerId) as string
    const models: CatalogModel[] = []
    for (const [modelKey, m] of Object.entries(prov.models)) {
      if (!m || typeof m !== "object") continue
      const id = (m.id ?? modelKey) as string
      const gatewayModel =
        providerId === "nexus" ? gatewayModels?.get(id) : undefined
      if (providerId === "nexus" && gatewayModels && !gatewayModel) continue
      const free = gatewayModel?.free ?? isFreeModel(m)
      const catalogModel: CatalogModel = {
        id,
        name: gatewayModel?.name ?? (m.name ?? id) as string,
        free,
        ...(gatewayModel?.contextWindow
          ? { contextWindow: gatewayModel.contextWindow }
          : typeof m.limit?.context === "number" &&
              Number.isFinite(m.limit.context) &&
              m.limit.context > 0
            ? { contextWindow: Math.floor(m.limit.context) }
          : {}),
        ...(gatewayModel?.maxOutputTokens
          ? { maxOutputTokens: gatewayModel.maxOutputTokens }
          : {}),
        recommendedIndex: typeof (m as { recommendedIndex?: number }).recommendedIndex === "number"
          ? (m as { recommendedIndex: number }).recommendedIndex
          : undefined,
      }
      models.push(catalogModel)
      if (free || typeof catalogModel.recommendedIndex === "number") {
        recommended.push({
          providerId,
          modelId: id,
          name: catalogModel.name,
          free,
          ...(catalogModel.contextWindow
            ? { contextWindow: catalogModel.contextWindow }
            : {}),
          ...(catalogModel.maxOutputTokens
            ? { maxOutputTokens: catalogModel.maxOutputTokens }
            : {}),
        })
      }
    }

    if (providerId === "nexus" && gatewayModels) {
      const existingIds = new Set(models.map((model) => model.id))
      for (const gatewayModel of gatewayModels.values()) {
        if (existingIds.has(gatewayModel.id)) continue
        const catalogModel: CatalogModel = {
          id: gatewayModel.id,
          name: gatewayModel.name ?? gatewayModel.id,
          free: gatewayModel.free ?? false,
          ...(gatewayModel.contextWindow
            ? { contextWindow: gatewayModel.contextWindow }
            : {}),
          ...(gatewayModel.maxOutputTokens
            ? { maxOutputTokens: gatewayModel.maxOutputTokens }
            : {}),
          recommendedIndex: undefined,
        }
        models.push(catalogModel)
        if (catalogModel.free) {
          recommended.push({
            providerId,
            modelId: catalogModel.id,
            name: catalogModel.name,
            free: true,
            ...(catalogModel.contextWindow
              ? { contextWindow: catalogModel.contextWindow }
              : {}),
            ...(catalogModel.maxOutputTokens
              ? { maxOutputTokens: catalogModel.maxOutputTokens }
              : {}),
          })
        }
      }
    }

    if (models.length > 0) {
      // Sort: free first, then by recommendedIndex, then by name
      models.sort((a, b) => {
        if (a.free !== b.free) return a.free ? -1 : 1
        const ra = a.recommendedIndex ?? 9999
        const rb = b.recommendedIndex ?? 9999
        if (ra !== rb) return ra - rb
        return a.name.localeCompare(b.name)
      })
      providers.push({
        id: providerId,
        name,
        baseUrl,
        models,
      })
    }
  }

  if (
    gatewayModels?.size &&
    !providers.some((provider) => provider.id === "nexus")
  ) {
    const models = [...gatewayModels.values()]
      .map<CatalogModel>((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        free: model.free ?? false,
        ...(model.contextWindow
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(model.maxOutputTokens
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
        recommendedIndex: undefined,
      }))
      .sort((a, b) => {
        if (a.free !== b.free) return a.free ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    providers.push({
      id: "nexus",
      name: "Nexus Gateway",
      baseUrl: NEXUS_GATEWAY_BASE_URL,
      models,
    })
    for (const model of models.filter((candidate) => candidate.free)) {
      recommended.push({
        providerId: "nexus",
        modelId: model.id,
        name: model.name,
        free: true,
        ...(model.contextWindow
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(model.maxOutputTokens
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
      })
    }
  }

  recommended.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1
    if (a.providerId !== b.providerId) {
      if (a.providerId === "nexus") return -1
      if (b.providerId === "nexus") return 1
    }
    return a.name.localeCompare(b.name)
  })

  return { providers, recommended }
}

/** Fallback when fetch fails: default free models so "Select model" still works */
function getFallbackCatalog(): ModelsCatalog {
  const recommended: ModelsCatalog["recommended"] = [
    {
      providerId: "nexus",
      modelId: "kilo-auto/free",
      name: "Kilo Auto (free)",
      free: true,
      contextWindow: 256_000,
    },
    { providerId: "nexus", modelId: "openrouter/free", name: "OpenRouter Free Router", free: true },
  ]
  return {
    providers: [
      {
        id: "nexus",
        name: "Nexus Gateway",
        baseUrl: NEXUS_GATEWAY_BASE_URL,
        models: recommended.map((r) => ({
          id: r.modelId,
          name: r.name,
          free: r.free,
          ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}),
        })),
      },
    ],
    recommended,
  }
}

/**
 * Resolve a catalog selection to Nexus model config (provider + id + baseUrl).
 * Selection is from getModelsCatalog().recommended or .providers[].models.
 */
export function catalogSelectionToModel(
  providerId: string,
  modelId: string,
  catalog: ModelsCatalog,
): {
  provider: string
  id: string
  baseUrl: string
  contextWindow?: number
} {
  const prov = catalog.providers.find((p) => p.id === providerId)
  const selected = prov?.models.find((model) => model.id === modelId)
  const baseUrl =
    prov?.baseUrl ??
    (providerId === "nexus" || providerId === "kilo" ? NEXUS_GATEWAY_BASE_URL : OPENROUTER_BASE_URL)
  return {
    provider: "openai-compatible",
    id: modelId,
    baseUrl,
    ...(selected?.contextWindow
      ? { contextWindow: selected.contextWindow }
      : {}),
  }
}
