/**
 * Models catalog from models.dev (same source as KiloCode/OpenCode).
 * Used by CLI and extension to show "Select model" with Recommended / free models.
 * Free models (cost.input === 0) are sorted first so users can start without an API key (OpenRouter free tier).
 */

const DEFAULT_MODELS_URL = "https://models.dev/api.json"
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const NEXUS_GATEWAY_BASE_URL = "https://api.kilo.ai/api/gateway"

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
  if (key === "openrouter" || key === "kilo") return true
  const api = (p.api ?? "").toLowerCase()
  return api.includes("openrouter.ai") || api.includes("api.kilo.ai")
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
 * Load catalog: from NEXUS_MODELS_PATH file, or fetch from NEXUS_MODELS_URL (models.dev).
 * Supported gateway providers are mapped to Nexus openai-compatible + baseUrl.
 */
export async function getModelsCatalog(): Promise<ModelsCatalog> {
  const now = Date.now()
  if (cachedCatalog && now - cachedAt < CACHE_MS) {
    return cachedCatalog
  }
  const gatewayModelIds = await getNexusGatewayModelIds()

  const path = getModelsPath()
  if (path) {
    try {
      const fs = await import("node:fs/promises")
      const content = await fs.readFile(path, "utf8")
      const data = JSON.parse(content) as Record<string, unknown>
      cachedCatalog = parseCatalog(data, gatewayModelIds)
      cachedAt = now
      return cachedCatalog
    } catch {
      // fallback to fetch
    }
  }

  const url = getModelsUrl()
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`models.dev fetch: ${res.status}`)
    const data = (await res.json()) as Record<string, unknown>
    cachedCatalog = parseCatalog(data, gatewayModelIds)
    cachedAt = now
    return cachedCatalog
  } catch (e) {
    // Return minimal catalog so UI still works
    cachedCatalog = getFallbackCatalog()
    cachedAt = now
    return cachedCatalog
  }
}

async function getNexusGatewayModelIds(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${NEXUS_GATEWAY_BASE_URL}/models`, {
      signal: AbortSignal.timeout(12_000),
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
    const api = prov.api ?? ""

    const baseUrl = api.trim() || OPENROUTER_BASE_URL
    const name = providerKey === "kilo" ? "Nexus Gateway" : (prov.name ?? providerKey) as string
    const models: CatalogModel[] = []
    for (const [modelKey, m] of Object.entries(prov.models)) {
      if (!m || typeof m !== "object") continue
      const id = (m.id ?? modelKey) as string
      if (providerKey === "kilo" && gatewayModelIds && !gatewayModelIds.has(id)) continue
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
          providerId: providerKey,
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
        id: providerKey,
        name,
        baseUrl,
        models,
      })
    }
  }

  recommended.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1
    if (a.providerId !== b.providerId) {
      if (a.providerId === "kilo") return -1
      if (b.providerId === "kilo") return 1
    }
    return a.name.localeCompare(b.name)
  })

  return { providers, recommended }
}

/** Fallback when fetch fails: default free models so "Select model" still works */
function getFallbackCatalog(): ModelsCatalog {
  const recommended: ModelsCatalog["recommended"] = [
    { providerId: "kilo", modelId: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (free)", free: true },
    { providerId: "kilo", modelId: "moonshotai/kimi-k2.5:free", name: "Kimi K2.5 (free)", free: true },
    { providerId: "kilo", modelId: "arcee-ai/trinity-large-preview:free", name: "Arcee Trinity Large Preview (free)", free: true },
    { providerId: "kilo", modelId: "stepfun/step-3.5-flash:free", name: "Step 3.5 Flash (free)", free: true },
    { providerId: "kilo", modelId: "corethink:free", name: "CoreThink (free)", free: true },
  ]
  return {
    providers: [
      {
        id: "kilo",
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
  const baseUrl = prov?.baseUrl ?? (providerId === "kilo" ? NEXUS_GATEWAY_BASE_URL : OPENROUTER_BASE_URL)
  return {
    provider: "openai-compatible",
    id: modelId,
    baseUrl,
  }
}
