import type { EmbeddingConfig, ProviderConfig, ProviderName } from "../types.js"

export type CredentialPurpose = "chat" | "embeddings"

export interface CredentialIdentity {
  purpose: CredentialPurpose
  provider: string
  destination: string
}

export interface ResolvedCredential {
  identity: CredentialIdentity
  apiKey?: string
  source: "explicit" | "environment" | "local" | "kilo-free" | "native"
}

interface ProviderCredentialSpec {
  defaultBaseUrl?: string
  environmentKeys?: string[]
  keyless?: boolean
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const KILO_BASE_URL = "https://api.kilo.ai/api/openrouter"

const CHAT_PROVIDER_SPECS: Partial<Record<ProviderName, ProviderCredentialSpec>> = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    environmentKeys: ["OPENAI_API_KEY"],
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    environmentKeys: ["ANTHROPIC_API_KEY"],
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    environmentKeys: [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ],
  },
  groq: {
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    environmentKeys: ["GROQ_API_KEY"],
  },
  mistral: {
    defaultBaseUrl: "https://api.mistral.ai/v1",
    environmentKeys: ["MISTRAL_API_KEY"],
  },
  xai: {
    defaultBaseUrl: "https://api.x.ai/v1",
    environmentKeys: ["XAI_API_KEY"],
  },
  deepinfra: {
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    environmentKeys: ["DEEPINFRA_API_KEY"],
  },
  cerebras: {
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    environmentKeys: ["CEREBRAS_API_KEY"],
  },
  cohere: {
    defaultBaseUrl: "https://api.cohere.com/compatibility/v1",
    environmentKeys: ["COHERE_API_KEY"],
  },
  togetherai: {
    defaultBaseUrl: "https://api.together.xyz/v1",
    environmentKeys: ["TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"],
  },
  perplexity: {
    defaultBaseUrl: "https://api.perplexity.ai",
    environmentKeys: ["PERPLEXITY_API_KEY"],
  },
  minimax: {
    defaultBaseUrl: "https://api.minimax.io/anthropic",
    environmentKeys: ["MINIMAX_API_KEY"],
  },
  ollama: {
    defaultBaseUrl: "http://localhost:11434/v1",
  },
}

const EMBEDDING_PROVIDER_SPECS: Partial<
  Record<EmbeddingConfig["provider"], ProviderCredentialSpec>
> = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    environmentKeys: ["OPENAI_API_KEY"],
  },
  openrouter: {
    defaultBaseUrl: OPENROUTER_BASE_URL,
    environmentKeys: ["OPENROUTER_API_KEY"],
  },
  google: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    environmentKeys: [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ],
  },
  mistral: {
    defaultBaseUrl: "https://api.mistral.ai/v1",
    environmentKeys: ["MISTRAL_API_KEY"],
  },
  ollama: {
    defaultBaseUrl: "http://localhost:11434/v1",
  },
  local: { keyless: true },
  bedrock: { keyless: true },
}

/**
 * Canonical credential destinations deliberately retain the complete base path:
 * credentials for two tenants on one host are not interchangeable.
 */
export function canonicalizeCredentialDestination(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error(`Invalid credential destination: ${baseUrl}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported credential destination protocol: ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error("Credential destination must not include userinfo")
  }
  if (url.search || url.hash) {
    throw new Error("Credential destination must not include a query string or fragment")
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "")
  if (!hostname) throw new Error("Credential destination must include a hostname")
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
  const port = url.port ? `:${url.port}` : ""
  const path = normalizeBasePath(url.pathname)
  return `${url.protocol}//${host}${port}${path}`
}

export function getProviderCredentialIdentity(
  config: ProviderConfig,
): CredentialIdentity {
  const provider = normalizeProviderName(config.provider)
  return {
    purpose: "chat",
    provider,
    destination: providerDestination(config),
  }
}

export function getEmbeddingCredentialIdentity(
  config: EmbeddingConfig,
): CredentialIdentity {
  const provider = normalizeEmbeddingProvider(config.provider)
  return {
    purpose: "embeddings",
    provider,
    destination: embeddingDestination(config),
  }
}

export function credentialIdentityKey(identity: CredentialIdentity): string {
  return JSON.stringify([
    identity.purpose,
    identity.provider,
    identity.destination,
  ])
}

export function resolveProviderCredential(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  const identity = getProviderCredentialIdentity(config)
  const explicit = nonEmpty(config.apiKey)
  if (explicit !== undefined) {
    return { identity, apiKey: explicit, source: "explicit" }
  }

  if (config.provider === "bedrock") {
    return { identity, source: "native" }
  }

  if (
    config.provider === "ollama"
      ? isTrustedLocalOllamaDestination(identity.destination)
      : isLoopbackDestination(identity.destination)
  ) {
    return { identity, apiKey: "dummy", source: "local" }
  }

  const environmentKeys = officialEnvironmentKeysForProvider(config, identity)
  const ambient = firstEnvironmentValue(environmentKeys, env)
  if (ambient !== undefined) {
    return { identity, apiKey: ambient, source: "environment" }
  }

  if (isRecognizedKiloFreeRoute(config, identity)) {
    return { identity, apiKey: "dummy", source: "kilo-free" }
  }

  throw missingCredentialError(identity, environmentKeys)
}

export function resolveEmbeddingCredential(
  config: EmbeddingConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  const identity = getEmbeddingCredentialIdentity(config)
  const explicit = nonEmpty(config.apiKey)
  if (explicit !== undefined) {
    return { identity, apiKey: explicit, source: "explicit" }
  }

  const spec = EMBEDDING_PROVIDER_SPECS[config.provider]
  if (
    spec?.keyless ||
    (
      config.provider === "ollama"
        ? isTrustedLocalOllamaDestination(identity.destination)
        : isLoopbackDestination(identity.destination)
    )
  ) {
    return { identity, apiKey: "dummy", source: config.provider === "bedrock" ? "native" : "local" }
  }

  const environmentKeys = officialEnvironmentKeysForEmbedding(config, identity)
  const ambient = firstEnvironmentValue(environmentKeys, env)
  if (ambient !== undefined) {
    return { identity, apiKey: ambient, source: "environment" }
  }

  throw missingCredentialError(identity, environmentKeys)
}

export function mergeProviderConfigSafely(
  current: ProviderConfig,
  patch: Partial<ProviderConfig>,
): ProviderConfig {
  const effectivePatch = { ...patch }
  const patchProvider = nonEmpty(effectivePatch.provider)
  const providerChanged =
    patchProvider !== undefined &&
    normalizeProviderName(patchProvider as ProviderName) !==
      normalizeProviderName(current.provider)
  const candidate = buildProviderCandidate(current, effectivePatch)
  const scopeChanged = providerCredentialScopeChanged(current, candidate)
  if (scopeChanged) {
    dropStaleInheritedFields(
      current as unknown as Record<string, unknown>,
      effectivePatch as Record<string, unknown>,
      [
        "apiKey",
        "baseUrl",
        "resourceName",
        "deploymentId",
        "apiVersion",
        "extra",
      ],
    )
  }
  const hasBaseUrlPatch = Object.prototype.hasOwnProperty.call(
    effectivePatch,
    "baseUrl",
  )
  const nextBaseUrl = nonEmpty(effectivePatch.baseUrl)
  if (scopeChanged && structurallyEqual(effectivePatch.apiKey, current.apiKey)) {
    delete effectivePatch.apiKey
  }

  const next = { ...current } as Record<string, unknown>
  if (scopeChanged) {
    delete next["apiKey"]
    delete next["resourceName"]
    delete next["deploymentId"]
    delete next["apiVersion"]
    delete next["extra"]
  }
  if (providerChanged && !hasBaseUrlPatch) {
    delete next["baseUrl"]
  }

  applyDefinedPatch(next, effectivePatch as Record<string, unknown>)
  if (hasBaseUrlPatch && nextBaseUrl === undefined) delete next["baseUrl"]
  if (
    Object.prototype.hasOwnProperty.call(effectivePatch, "apiKey") &&
    nonEmpty(effectivePatch.apiKey) === undefined
  ) {
    delete next["apiKey"]
  }
  if (isRecord(next["extra"])) {
    const sanitizedExtra = sanitizeProviderExtra(next["extra"])
    if (Object.keys(sanitizedExtra).length > 0) next["extra"] = sanitizedExtra
    else delete next["extra"]
  }
  return next as unknown as ProviderConfig
}

export function mergeProviderConfigPartialSafely(
  current: Partial<ProviderConfig>,
  patch: Partial<ProviderConfig>,
): Partial<ProviderConfig> {
  const hasProvider =
    current.provider !== undefined ||
    patch.provider !== undefined
  const hasId = current.id !== undefined || patch.id !== undefined
  const synthetic: ProviderConfig = {
    provider: current.provider ?? "openai-compatible",
    id: current.id ?? "__partial_profile__",
    ...current,
  }
  const merged = mergeProviderConfigSafely(synthetic, patch)
  if (!hasProvider) delete (merged as Partial<ProviderConfig>).provider
  if (!hasId) delete (merged as Partial<ProviderConfig>).id
  return merged
}

/**
 * Apply a preset's model selector as one endpoint-aware transaction.
 * `openrouter` is an alias with a fixed trusted endpoint. A generic compatible
 * preset must reuse an already explicit compatible endpoint; provider+model
 * alone is not a complete or safe selection.
 */
export function mergeModelPresetSelection(
  current: ProviderConfig,
  provider: string,
  modelId: string,
): ProviderConfig {
  const normalizedProvider = provider.trim().toLowerCase()
  const id = modelId.trim()
  if (!normalizedProvider || !id) {
    throw new Error("Model preset requires provider and model id")
  }
  if (normalizedProvider === "openrouter") {
    return mergeProviderConfigSafely(current, {
      provider: "openai-compatible",
      id,
      baseUrl: OPENROUTER_BASE_URL,
    })
  }
  if (normalizedProvider === "openai-compatible") {
    if (
      current.provider !== "openai-compatible" ||
      !nonEmpty(current.baseUrl)
    ) {
      throw new Error(
        "openai-compatible preset requires an explicit baseUrl",
      )
    }
    return mergeProviderConfigSafely(current, {
      provider: "openai-compatible",
      id,
      baseUrl: current.baseUrl,
    })
  }
  return mergeProviderConfigSafely(current, {
    provider: normalizedProvider as ProviderName,
    id,
  })
}

/**
 * Profile activation is a new credential binding even when provider and
 * destination match the active profile. Never inherit the active key.
 */
export function selectProviderProfile(
  base: ProviderConfig,
  profile: Partial<ProviderConfig>,
): ProviderConfig {
  const cleanBase = { ...base }
  delete cleanBase.apiKey
  return mergeProviderConfigSafely(cleanBase, profile)
}

export function mergeEmbeddingConfigSafely(
  current: EmbeddingConfig,
  patch: Partial<EmbeddingConfig>,
): EmbeddingConfig {
  const effectivePatch = { ...patch }
  const providerChanged =
    effectivePatch.provider !== undefined &&
    normalizeEmbeddingProvider(effectivePatch.provider) !==
      normalizeEmbeddingProvider(current.provider)
  const candidate = buildEmbeddingCandidate(current, effectivePatch)
  const scopeChanged = embeddingCredentialScopeChanged(current, candidate)
  if (scopeChanged) {
    dropStaleInheritedFields(
      current as unknown as Record<string, unknown>,
      effectivePatch as Record<string, unknown>,
      ["apiKey", "baseUrl", "region"],
    )
  }
  const hasBaseUrlPatch = Object.prototype.hasOwnProperty.call(effectivePatch, "baseUrl")
  const nextBaseUrl = nonEmpty(effectivePatch.baseUrl)
  if (
    scopeChanged &&
    structurallyEqual(effectivePatch.apiKey, current.apiKey)
  ) {
    delete effectivePatch.apiKey
  }
  const next = { ...current } as Record<string, unknown>

  if (scopeChanged) {
    delete next["apiKey"]
    delete next["region"]
  }
  if (providerChanged && !hasBaseUrlPatch) delete next["baseUrl"]

  applyDefinedPatch(next, effectivePatch as Record<string, unknown>)
  if (hasBaseUrlPatch && nextBaseUrl === undefined) delete next["baseUrl"]
  if (
    Object.prototype.hasOwnProperty.call(effectivePatch, "apiKey") &&
    nonEmpty(effectivePatch.apiKey) === undefined
  ) {
    delete next["apiKey"]
  }
  return next as unknown as EmbeddingConfig
}

function providerDestination(config: ProviderConfig): string {
  if (config.provider === "openai-compatible") {
    const baseUrl = nonEmpty(config.baseUrl)
    if (!baseUrl) {
      throw new Error("openai-compatible provider requires baseUrl")
    }
    return canonicalizeCredentialDestination(normalizeKiloGatewayUrl(baseUrl))
  }
  if (config.provider === "azure") {
    const baseUrl = nonEmpty(config.baseUrl)
    if (baseUrl) {
      return canonicalizeCredentialDestination(baseUrl)
    }
    const resource = normalizeAzureResourceName(config.resourceName)
    return canonicalizeCredentialDestination(
      `https://${resource}.openai.azure.com`,
    )
  }
  if (config.provider === "bedrock") {
    const region = normalizeAwsRegion(
      nonEmpty(config.extra?.["region"]) ??
        nonEmpty(process.env["AWS_REGION"]) ??
        "us-east-1",
    )
    return `aws-bedrock://${region}`
  }
  const spec = CHAT_PROVIDER_SPECS[config.provider]
  let baseUrl = nonEmpty(config.baseUrl) ?? spec?.defaultBaseUrl
  if (config.provider === "ollama" && baseUrl) {
    baseUrl = normalizeOllamaApiBaseUrl(baseUrl)
  }
  if (!baseUrl) return `${config.provider}://default`
  return canonicalizeCredentialDestination(baseUrl)
}

function embeddingDestination(config: EmbeddingConfig): string {
  if (config.provider === "local") return "local://feature-hashing"
  if (config.provider === "bedrock") {
    const region = normalizeAwsRegion(
      nonEmpty(config.region) ??
        nonEmpty(process.env["AWS_REGION"]) ??
        "us-east-1",
    )
    return `aws-bedrock://${region}`
  }
  if (config.provider === "openai-compatible" && !nonEmpty(config.baseUrl)) {
    throw new Error("openai-compatible embeddings require baseUrl")
  }
  const spec = EMBEDDING_PROVIDER_SPECS[config.provider]
  let baseUrl = nonEmpty(config.baseUrl) ?? spec?.defaultBaseUrl
  if (config.provider === "ollama" && baseUrl) {
    baseUrl = normalizeOllamaApiBaseUrl(baseUrl)
  }
  if (!baseUrl) return `${config.provider}://default`
  return canonicalizeCredentialDestination(baseUrl)
}

function officialEnvironmentKeysForProvider(
  config: ProviderConfig,
  identity: CredentialIdentity,
): string[] {
  if (config.provider === "openai-compatible") {
    if (isOfficialKiloDestination(identity.destination)) return ["KILO_API_KEY"]
    if (identity.destination === OPENROUTER_BASE_URL) return ["OPENROUTER_API_KEY"]
    if (identity.destination === "https://api.openai.com/v1") return ["OPENAI_API_KEY"]
    return []
  }
  if (config.provider === "azure") {
    if (config.baseUrl) return []
    return ["AZURE_OPENAI_API_KEY", "AZURE_API_KEY"]
  }
  const spec = CHAT_PROVIDER_SPECS[config.provider]
  if (!spec?.defaultBaseUrl || !spec.environmentKeys) return []
  return identity.destination === canonicalizeCredentialDestination(spec.defaultBaseUrl)
    ? spec.environmentKeys
    : []
}

function isOfficialKiloDestination(destination: string): boolean {
  try {
    const url = new URL(destination)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "")
    return (
      url.protocol === "https:" &&
      hostname === "api.kilo.ai" &&
      (
        url.pathname === "/api/openrouter" ||
        url.pathname.startsWith("/api/organizations/")
      )
    )
  } catch {
    return false
  }
}

function officialEnvironmentKeysForEmbedding(
  config: EmbeddingConfig,
  identity: CredentialIdentity,
): string[] {
  if (config.provider === "openai-compatible") {
    if (identity.destination === "https://api.openai.com/v1") return ["OPENAI_API_KEY"]
    if (identity.destination === OPENROUTER_BASE_URL) return ["OPENROUTER_API_KEY"]
    if (identity.destination === KILO_BASE_URL) return ["KILO_API_KEY"]
    return []
  }
  const spec = EMBEDDING_PROVIDER_SPECS[config.provider]
  if (!spec?.defaultBaseUrl || !spec.environmentKeys) return []
  return identity.destination === canonicalizeCredentialDestination(spec.defaultBaseUrl)
    ? spec.environmentKeys
    : []
}

function normalizeProviderName(provider: ProviderName): string {
  return provider.toLowerCase()
}

function normalizeEmbeddingProvider(provider: EmbeddingConfig["provider"]): string {
  return provider === "openrouter" ? "openai-compatible" : provider.toLowerCase()
}

function normalizeKiloGatewayUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return baseUrl
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "")
  if (
    url.protocol === "https:" &&
    host === "api.kilo.ai" &&
    /^\/api\/gateway\/?$/i.test(url.pathname)
  ) {
    url.pathname = "/api/openrouter"
  }
  return url.toString()
}

export function normalizeAzureResourceName(value: unknown): string {
  const resource = nonEmpty(value)?.toLowerCase()
  if (
    !resource ||
    resource.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(resource)
  ) {
    throw new Error("Invalid Azure resource name: expected a single DNS label")
  }
  return resource
}

export function normalizeAwsRegion(value: unknown): string {
  const region = nonEmpty(value)
  if (
    !region ||
    region.length > 64 ||
    !/^[a-z]{2,4}(?:-[a-z0-9]+){1,3}-\d+$/.test(region)
  ) {
    throw new Error("Invalid AWS region")
  }
  return region
}

function normalizeOllamaApiBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "")
  return /\/v1$/i.test(value) ? value : `${value}/v1`
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") return ""
  return pathname.replace(/\/+$/, "")
}

function isLoopbackDestination(destination: string): boolean {
  if (destination.startsWith("local://")) return true
  try {
    const hostname = new URL(destination).hostname.toLowerCase().replace(/\.+$/, "")
    return (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

function isTrustedLocalOllamaDestination(destination: string): boolean {
  try {
    const url = new URL(destination)
    return (
      url.protocol === "http:" &&
      url.port === "11434" &&
      isLoopbackDestination(destination)
    )
  } catch {
    return false
  }
}

function isRecognizedKiloFreeRoute(
  config: ProviderConfig,
  identity: CredentialIdentity,
): boolean {
  const modelId = config.id.trim().toLowerCase()
  return (
    config.provider === "openai-compatible" &&
    identity.destination === KILO_BASE_URL &&
    (
      modelId.endsWith(":free") ||
      modelId === "kilo-auto/free" ||
      modelId === "openrouter/free"
    )
  )
}

function firstEnvironmentValue(
  names: string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of names) {
    const value = nonEmpty(env[name])
    if (value !== undefined) return value
  }
  return undefined
}

function missingCredentialError(
  identity: CredentialIdentity,
  environmentKeys: string[],
): Error {
  const hint = environmentKeys.length > 0
    ? ` or ${environmentKeys.join("/")}`
    : ""
  return new Error(
    `Missing API key for ${identity.provider} ${identity.purpose} destination ${identity.destination}. Set an explicitly bound apiKey${hint}.`,
  )
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function providerCredentialScopeChanged(
  current: ProviderConfig,
  candidate: ProviderConfig,
): boolean {
  try {
    return credentialIdentityKey(getProviderCredentialIdentity(current)) !==
      credentialIdentityKey(getProviderCredentialIdentity(candidate))
  } catch {
    return (
      normalizeProviderName(current.provider) !==
        normalizeProviderName(candidate.provider) ||
      nonEmpty(current.baseUrl) !== nonEmpty(candidate.baseUrl) ||
      nonEmpty(current.resourceName) !== nonEmpty(candidate.resourceName) ||
      nonEmpty(current.extra?.["region"]) !== nonEmpty(candidate.extra?.["region"])
    )
  }
}

function embeddingCredentialScopeChanged(
  current: EmbeddingConfig,
  candidate: EmbeddingConfig,
): boolean {
  try {
    return credentialIdentityKey(getEmbeddingCredentialIdentity(current)) !==
      credentialIdentityKey(getEmbeddingCredentialIdentity(candidate))
  } catch {
    return (
      normalizeEmbeddingProvider(current.provider) !==
        normalizeEmbeddingProvider(candidate.provider) ||
      nonEmpty(current.baseUrl) !== nonEmpty(candidate.baseUrl) ||
      nonEmpty(current.region) !== nonEmpty(candidate.region)
    )
  }
}

function buildProviderCandidate(
  current: ProviderConfig,
  patch: Partial<ProviderConfig>,
): ProviderConfig {
  const candidate = { ...current } as Record<string, unknown>
  applyDefinedPatch(candidate, patch as Record<string, unknown>)
  if (
    Object.prototype.hasOwnProperty.call(patch, "baseUrl") &&
    nonEmpty(patch.baseUrl) === undefined
  ) {
    delete candidate["baseUrl"]
  }
  return candidate as unknown as ProviderConfig
}

function buildEmbeddingCandidate(
  current: EmbeddingConfig,
  patch: Partial<EmbeddingConfig>,
): EmbeddingConfig {
  const candidate = { ...current } as Record<string, unknown>
  applyDefinedPatch(candidate, patch as Record<string, unknown>)
  if (
    Object.prototype.hasOwnProperty.call(patch, "baseUrl") &&
    nonEmpty(patch.baseUrl) === undefined
  ) {
    delete candidate["baseUrl"]
  }
  return candidate as unknown as EmbeddingConfig
}

function applyDefinedPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value
  }
}

function dropStaleInheritedFields(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: string[],
): void {
  for (const field of fields) {
    if (
      Object.prototype.hasOwnProperty.call(patch, field) &&
      structurallyEqual(patch[field], current[field])
    ) {
      delete patch[field]
    }
  }
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

const PROVIDER_EXTRA_SECRET_FIELDS = new Set([
  "apikey",
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "auth",
  "token",
  "bearertoken",
  "password",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
])

function sanitizeProviderExtra(
  value: Record<string, unknown>,
  parentKey?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const inHeaders = normalizeSensitiveName(parentKey) === "headers"
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeSensitiveName(key)
    if (
      PROVIDER_EXTRA_SECRET_FIELDS.has(normalized) ||
      (
        inHeaders &&
        [
          "authorization",
          "proxyauthorization",
          "cookie",
          "setcookie",
          "apikey",
          "xapikey",
        ].includes(normalized)
      )
    ) {
      continue
    }
    if (Array.isArray(entry)) {
      out[key] = entry.map((item) =>
        isRecord(item) ? sanitizeProviderExtra(item) : item,
      )
    } else if (isRecord(entry)) {
      out[key] = sanitizeProviderExtra(entry, key)
    } else {
      out[key] = entry
    }
  }
  return out
}

function normalizeSensitiveName(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]/g, "")
    : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
