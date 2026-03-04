/**
 * Models catalog from models.dev.
 * Used by CLI and extension to show "Select model" with Recommended / free models.
 * Free models (cost.input === 0) are sorted first so users can start without an API key (OpenRouter free tier).
 */

const DEFAULT_MODELS_URL = "https://models.dev/api.json"
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const NEXUS_GATEWAY_BASE_URL = "https://api.kilo.ai/api/gateway"
const SOURCE_TIMEOUT_MS = 15_000

export interface CatalogModel {
  id: string
  name: string
  /** Zero-cost / free tier */
  free: boolean
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
  recommended: Array<{ providerId: string; modelId: string; name: string; free: boolean }>
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
    getNexusGatewayModelIds(),
    fetchUrl(),
    readPath(),
  ])

  const gatewayModelIds =
    gatewaySettled.status === "fulfilled" ? gatewaySettled.value : null

  const rawDataSources: Record<string, unknown>[] = []
  if (urlSettled.status === "fulfilled") rawDataSources.push(urlSettled.value)
  if (pathSettled.status === "fulfilled" && pathSettled.value)
    rawDataSources.push(pathSettled.value)

  if (rawDataSources.length === 0) {
    cachedCatalog = getFallbackCatalog()
    cachedAt = now
    return cachedCatalog
  }

  const catalogs = rawDataSources.map((data) =>
    parseCatalog(data, gatewayModelIds)
  )
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

async function getNexusGatewayModelIds(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${NEXUS_GATEWAY_BASE_URL}/models`, {
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: "Bearer dummy",
      },
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = new Set<string>()
    for (const model of json.data ?? []) {
      if (model?.id && typeof model.id === "string") ids.add(model.id)
    }
    return ids.size > 0 ? ids : null
  } catch {
    return null
  }
}

function parseCatalog(data: Record<string, unknown>, gatewayModelIds: Set<string> | null): ModelsCatalog {
  const providers: CatalogProvider[] = []
  const recommended: ModelsCatalog["recommended"] = []

  const rawProviders = data as Record<string, { id?: string; name?: string; api?: string; models?: Record<string, { id?: string; name?: string; cost?: { input?: number }; recommendedIndex?: number }> }>
  for (const [providerKey, prov] of Object.entries(rawProviders)) {
    if (!prov || typeof prov !== "object" || !prov.models) continue
    if (!isSupportedProvider(providerKey, prov)) continue
    const providerId = providerKey === "kilo" ? "nexus" : providerKey
    const api = prov.api ?? ""

    const baseUrl = api.trim() || OPENROUTER_BASE_URL
    const name = providerId === "nexus" ? "Nexus Gateway" : (prov.name ?? providerId) as string
    const models: CatalogModel[] = []
    for (const [modelKey, m] of Object.entries(prov.models)) {
      if (!m || typeof m !== "object") continue
      const id = (m.id ?? modelKey) as string
      if (providerId === "nexus" && gatewayModelIds && !gatewayModelIds.has(id)) continue
      const free = isFreeModel(m)
      const catalogModel: CatalogModel = {
        id,
        name: (m.name ?? id) as string,
        free,
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
        })
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
    { providerId: "nexus", modelId: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (free)", free: true },
    { providerId: "nexus", modelId: "moonshotai/kimi-k2.5:free", name: "Kimi K2.5 (free)", free: true },
    { providerId: "nexus", modelId: "arcee-ai/trinity-large-preview:free", name: "Arcee Trinity Large Preview (free)", free: true },
    { providerId: "nexus", modelId: "stepfun/step-3.5-flash:free", name: "Step 3.5 Flash (free)", free: true },
    { providerId: "nexus", modelId: "corethink:free", name: "CoreThink (free)", free: true },
  ]
  return {
    providers: [
      {
        id: "nexus",
        name: "Nexus Gateway",
        baseUrl: NEXUS_GATEWAY_BASE_URL,
        models: recommended.map((r) => ({ id: r.modelId, name: r.name, free: r.free })),
      },
    ],
    recommended,
  }
}

/**
 * Resolve a catalog selection to Nexus model config (provider + id + baseUrl).
 * Selection is from getModelsCatalog().recommended or .providers[].models.
 */
export function catalogSelectionToModel(providerId: string, modelId: string, catalog: ModelsCatalog): { provider: string; id: string; baseUrl: string } {
  const prov = catalog.providers.find((p) => p.id === providerId)
  const baseUrl =
    prov?.baseUrl ??
    (providerId === "nexus" || providerId === "kilo" ? NEXUS_GATEWAY_BASE_URL : OPENROUTER_BASE_URL)
  return {
    provider: "openai-compatible",
    id: modelId,
    baseUrl,
  }
}
