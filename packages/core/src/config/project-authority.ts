import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

import type {
  EmbeddingConfig,
  NexusConfig,
  ProviderConfig,
} from "../types.js"
import {
  mergeProviderConfigPartialSafely,
  mergeProviderConfigSafely,
} from "../provider/credential-identity.js"

const MAX_AUTHORITY_PAYLOAD_BYTES = 65_536
const MAX_AUTHORITY_ARRAY_ITEMS = 256
const MAX_AUTHORITY_STRING_CHARS = 8_192
const MAX_AUTHORITY_VALUE_DEPTH = 32
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

const boundedString = z.string().min(1).max(MAX_AUTHORITY_STRING_CHARS)
const httpUrlString = boundedString.refine((value) => {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}, "Authority endpoint must be an HTTP(S) URL without userinfo")
const providerNameSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "ollama",
  "openai-compatible",
  "azure",
  "bedrock",
  "groq",
  "mistral",
  "xai",
  "deepinfra",
  "cerebras",
  "cohere",
  "togetherai",
  "perplexity",
  "minimax",
])
const embeddingProviderSchema = z.enum([
  "openai",
  "openai-compatible",
  "openrouter",
  "ollama",
  "google",
  "mistral",
  "bedrock",
  "local",
])

const modelEndpointPayloadSchema = z.object({
  model: z.object({
    provider: providerNameSchema.optional(),
    baseUrl: httpUrlString.optional(),
    resourceName: boundedString.optional(),
    deploymentId: boundedString.optional(),
    apiVersion: boundedString.optional(),
    extra: z.record(z.unknown()).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
}).strict()

const embeddingsEndpointPayloadSchema = z.object({
  embeddings: z.object({
    provider: embeddingProviderSchema,
    model: boundedString,
    baseUrl: httpUrlString.optional(),
    dimensions: z.number().int().positive().optional(),
    region: boundedString.optional(),
  }).strict(),
}).strict()

const vectorDbEndpointPayloadSchema = z.object({
  vectorDb: z.object({
    url: httpUrlString.optional(),
    autoStart: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
}).strict()
const claudeGlobalDirectoryPayloadSchema = z.object({
  compatibility: z.object({
    claude: z.object({
      includeGlobalDir: z.literal(true),
    }).strict(),
  }).strict(),
}).strict()

const stringArraySchema = z.array(boundedString).max(MAX_AUTHORITY_ARRAY_ITEMS)
const skillEntrySchema = z.union([
  boundedString,
  z.object({
    path: boundedString,
    enabled: z.boolean().optional(),
  }).strict(),
])
const profileSchema = z.object({
  provider: providerNameSchema.optional(),
  id: boundedString.optional(),
  baseUrl: httpUrlString.optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: boundedString.optional(),
  reasoningHistoryMode: z
    .enum(["auto", "inline", "reasoning_content", "reasoning_details"])
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  resourceName: boundedString.optional(),
  deploymentId: boundedString.optional(),
  apiVersion: boundedString.optional(),
  extra: z.record(z.unknown()).optional(),
}).strict()

export const PROJECT_AUTHORITY_REQUEST_KINDS = [
  "model-endpoint",
  "embeddings-endpoint",
  "vector-db-endpoint",
  "remote-skills",
  "custom-tools",
  "profiles",
  "external-skill-paths",
  "external-rule-paths",
  "external-memory-path",
  "claude-global-directory",
] as const

export type ProjectAuthorityRequestKind =
  typeof PROJECT_AUTHORITY_REQUEST_KINDS[number]

export interface ProjectAuthorityPayloadByKind {
  "model-endpoint": z.infer<typeof modelEndpointPayloadSchema>
  "embeddings-endpoint": z.infer<typeof embeddingsEndpointPayloadSchema>
  "vector-db-endpoint": z.infer<typeof vectorDbEndpointPayloadSchema>
  "remote-skills": { skillsUrls: string[] }
  "custom-tools": { tools: { custom: string[] } }
  "profiles": { profiles: Record<string, Partial<ProviderConfig>> }
  "external-skill-paths": {
    skills: Array<string | { path: string; enabled?: boolean }>
  }
  "external-rule-paths": { rules: { files: string[] } }
  "external-memory-path": { memory: { autoMemoryDirectory: string } }
  "claude-global-directory": {
    compatibility: { claude: { includeGlobalDir: true } }
  }
}

const payloadSchemas: {
  [K in ProjectAuthorityRequestKind]: z.ZodType<ProjectAuthorityPayloadByKind[K]>
} = {
  "model-endpoint": modelEndpointPayloadSchema,
  "embeddings-endpoint": embeddingsEndpointPayloadSchema,
  "vector-db-endpoint": vectorDbEndpointPayloadSchema,
  "remote-skills": z.object({
    skillsUrls: z.array(httpUrlString).max(MAX_AUTHORITY_ARRAY_ITEMS),
  }).strict(),
  "custom-tools": z.object({
    tools: z.object({
      custom: z.array(boundedString).max(128),
    }).strict(),
  }).strict(),
  profiles: z.object({
    profiles: z.record(profileSchema)
      .refine((profiles) => Object.keys(profiles).length <= MAX_AUTHORITY_ARRAY_ITEMS),
  }).strict(),
  "external-skill-paths": z.object({
    skills: z.array(skillEntrySchema).max(MAX_AUTHORITY_ARRAY_ITEMS),
  }).strict(),
  "external-rule-paths": z.object({
    rules: z.object({ files: stringArraySchema }).strict(),
  }).strict(),
  "external-memory-path": z.object({
    memory: z.object({
      autoMemoryDirectory: boundedString,
    }).strict(),
  }).strict(),
  "claude-global-directory": claudeGlobalDirectoryPayloadSchema,
}

export interface PendingProjectAuthorityRequest<
  K extends ProjectAuthorityRequestKind = ProjectAuthorityRequestKind,
> {
  source: "project"
  origin: "project-config"
  status: "pending"
  kind: K
  fingerprint: string
  payload: ProjectAuthorityPayloadByKind[K]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry)) as T
  }
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      cloneConfigValue(child),
    ]),
  ) as T
}

function stableConfigValue(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): string {
  if (depth > MAX_AUTHORITY_VALUE_DEPTH) {
    throw new Error("Project authority payload exceeds its depth limit")
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) {
      throw new Error("Project authority payload contains a cyclic value")
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        return `[${value
          .map((entry) => stableConfigValue(entry, depth + 1, ancestors))
          .join(",")}]`
      }
      return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) =>
          `${JSON.stringify(key)}:${stableConfigValue(
            child,
            depth + 1,
            ancestors,
          )}`)
        .join(",")}}`
    } finally {
      ancestors.delete(value)
    }
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error("Project authority payload contains an unsupported value")
  }
  return serialized
}

export function fingerprintProjectAuthorityPayload(
  kind: ProjectAuthorityRequestKind,
  payload: unknown,
): string {
  return crypto
    .createHash("sha256")
    .update("nexus-project-config-authority-v1\0")
    .update(kind)
    .update("\0")
    .update(stableConfigValue(payload))
    .digest("hex")
}

function parseAuthorityPayload<K extends ProjectAuthorityRequestKind>(
  kind: K,
  payload: unknown,
): ProjectAuthorityPayloadByKind[K] {
  const parsed = payloadSchemas[kind].parse(payload) as
    ProjectAuthorityPayloadByKind[K]
  if (
    Buffer.byteLength(stableConfigValue(parsed), "utf8") >
    MAX_AUTHORITY_PAYLOAD_BYTES
  ) {
    throw new Error("Project authority payload exceeds its size limit")
  }
  return parsed
}

export function createPendingProjectAuthorityRequest<
  K extends ProjectAuthorityRequestKind,
>(
  kind: K,
  payload: ProjectAuthorityPayloadByKind[K],
): PendingProjectAuthorityRequest<K> {
  const parsed = parseAuthorityPayload(kind, payload)
  return {
    source: "project",
    origin: "project-config",
    status: "pending",
    kind,
    fingerprint: fingerprintProjectAuthorityPayload(kind, parsed),
    payload: parsed,
  }
}

export function isValidPendingProjectAuthorityRequest(
  value: unknown,
): value is PendingProjectAuthorityRequest {
  if (!isPlainObject(value)) return false
  if (
    value.source !== "project" ||
    value.origin !== "project-config" ||
    value.status !== "pending" ||
    typeof value.kind !== "string" ||
    !(PROJECT_AUTHORITY_REQUEST_KINDS as readonly string[]).includes(value.kind) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    return false
  }
  try {
    const kind = value.kind as ProjectAuthorityRequestKind
    const payload = parseAuthorityPayload(kind, value.payload)
    return value.fingerprint ===
      fingerprintProjectAuthorityPayload(kind, payload)
  } catch {
    return false
  }
}

export const PendingProjectAuthorityRequestSchema = z
  .object({
    source: z.literal("project"),
    origin: z.literal("project-config"),
    status: z.literal("pending"),
    kind: z.enum(PROJECT_AUTHORITY_REQUEST_KINDS),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    payload: z.unknown(),
  })
  .superRefine((request, context) => {
    if (!isValidPendingProjectAuthorityRequest(request)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Project authority request content does not match its fingerprint",
      })
    }
  }) as z.ZodType<PendingProjectAuthorityRequest>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function normalizeOpenRouterEndpoint(
  endpoint: Record<string, unknown>,
): void {
  if (endpoint["provider"] !== "openrouter") return
  endpoint["provider"] = "openai-compatible"
  if (
    typeof endpoint["baseUrl"] !== "string" ||
    endpoint["baseUrl"].trim().length === 0
  ) {
    endpoint["baseUrl"] = OPENROUTER_BASE_URL
  }
}

function valuePath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  const record = asRecord(entry)
  return typeof record?.["path"] === "string"
    ? record["path"]
    : undefined
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
}

function nonGlobPrefix(value: string): string {
  const globIndex = value.search(/[*?[\]{}()!]/u)
  return globIndex < 0 ? value : value.slice(0, globIndex)
}

function isExternalProjectPath(value: string, projectRoot?: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith("~")) return true
  if (!projectRoot) {
    return path.isAbsolute(trimmed) ||
      trimmed === ".." ||
      trimmed.startsWith(`..${path.sep}`) ||
      trimmed.startsWith("../")
  }
  const canonicalRoot = fs.realpathSync(projectRoot)
  const prefix = nonGlobPrefix(trimmed) || "."
  const candidate = path.isAbsolute(prefix)
    ? path.resolve(prefix)
    : path.resolve(canonicalRoot, prefix)
  if (!pathWithin(canonicalRoot, candidate)) return true
  try {
    return !pathWithin(canonicalRoot, fs.realpathSync(candidate))
  } catch {
    return false
  }
}

export interface ProjectAuthorityPartition {
  safeProject: Record<string, unknown>
  pending: PendingProjectAuthorityRequest[]
}

export function partitionProjectAuthority(
  project: Record<string, unknown>,
  options: {
    projectRoot?: string
    hostAllowsClaudeGlobalDirectory?: boolean
  } = {},
): ProjectAuthorityPartition {
  const safeProject = cloneConfigValue(project)
  delete safeProject["pendingProjectAuthority"]
  const pending: PendingProjectAuthorityRequest[] = []

  const model = asRecord(safeProject["model"])
  if (model) {
    const endpoint: Record<string, unknown> = {}
    for (const key of [
      "provider",
      "baseUrl",
      "resourceName",
      "deploymentId",
      "apiVersion",
      "extra",
    ]) {
      if (Object.prototype.hasOwnProperty.call(model, key)) {
        endpoint[key] = model[key]
        delete model[key]
      }
    }
    delete model["apiKey"]
    if (Object.keys(endpoint).length > 0) {
      normalizeOpenRouterEndpoint(endpoint)
      pending.push(createPendingProjectAuthorityRequest(
        "model-endpoint",
        { model: endpoint } as ProjectAuthorityPayloadByKind["model-endpoint"],
      ))
    }
  }

  const embeddings = asRecord(safeProject["embeddings"])
  if (embeddings) {
    delete embeddings["apiKey"]
    pending.push(createPendingProjectAuthorityRequest(
      "embeddings-endpoint",
      {
        embeddings: embeddings as unknown as EmbeddingConfig,
      },
    ))
    delete safeProject["embeddings"]
  }

  const vectorDb = asRecord(safeProject["vectorDb"])
  if (vectorDb) {
    const endpoint: { url?: string; autoStart?: boolean } = {}
    if (typeof vectorDb["url"] === "string") {
      endpoint.url = vectorDb["url"]
      delete vectorDb["url"]
    }
    if (vectorDb["autoStart"] === true) {
      endpoint.autoStart = vectorDb["autoStart"]
      delete vectorDb["autoStart"]
    }
    delete vectorDb["apiKey"]
    if (Object.keys(endpoint).length > 0) {
      pending.push(createPendingProjectAuthorityRequest(
        "vector-db-endpoint",
        { vectorDb: endpoint },
      ))
    }
  }

  const skillsUrls = safeProject["skillsUrls"]
  if (Array.isArray(skillsUrls) && skillsUrls.length > 0) {
    pending.push(createPendingProjectAuthorityRequest(
      "remote-skills",
      { skillsUrls: cloneConfigValue(skillsUrls) as string[] },
    ))
    delete safeProject["skillsUrls"]
  }

  const tools = asRecord(safeProject["tools"])
  if (tools && Array.isArray(tools["custom"]) && tools["custom"].length > 0) {
    pending.push(createPendingProjectAuthorityRequest(
      "custom-tools",
      { tools: { custom: cloneConfigValue(tools["custom"]) as string[] } },
    ))
    delete tools["custom"]
  }

  const profiles = asRecord(safeProject["profiles"])
  if (profiles && Object.keys(profiles).length > 0) {
    for (const profile of Object.values(profiles)) {
      const record = asRecord(profile)
      if (!record) continue
      delete record["apiKey"]
      normalizeOpenRouterEndpoint(record)
    }
    pending.push(createPendingProjectAuthorityRequest(
      "profiles",
      {
        profiles: profiles as Record<string, Partial<ProviderConfig>>,
      },
    ))
    delete safeProject["profiles"]
  }

  const skills = safeProject["skills"]
  if (Array.isArray(skills)) {
    const external = skills.filter((entry) => {
      const configuredPath = valuePath(entry)
      return configuredPath
        ? isExternalProjectPath(configuredPath, options.projectRoot)
        : true
    }) as Array<string | { path: string; enabled?: boolean }>
    safeProject["skills"] = skills.filter((entry) => !external.includes(entry))
    if (external.length > 0) {
      pending.push(createPendingProjectAuthorityRequest(
        "external-skill-paths",
        { skills: cloneConfigValue(external) },
      ))
    }
  }

  const rules = asRecord(safeProject["rules"])
  if (rules && Array.isArray(rules["files"])) {
    const files = rules["files"] as string[]
    const external = files.filter((configuredPath) =>
      isExternalProjectPath(configuredPath, options.projectRoot))
    rules["files"] = files.filter((configuredPath) =>
      !external.includes(configuredPath))
    if (external.length > 0) {
      pending.push(createPendingProjectAuthorityRequest(
        "external-rule-paths",
        { rules: { files: cloneConfigValue(external) } },
      ))
    }
  }

  const memory = asRecord(safeProject["memory"])
  const memoryPath = memory?.["autoMemoryDirectory"]
  if (
    memory &&
    typeof memoryPath === "string" &&
    isExternalProjectPath(memoryPath, options.projectRoot)
  ) {
    pending.push(createPendingProjectAuthorityRequest(
      "external-memory-path",
      { memory: { autoMemoryDirectory: memoryPath } },
    ))
    delete memory["autoMemoryDirectory"]
  }

  const compatibility = asRecord(safeProject["compatibility"])
  const claude = asRecord(compatibility?.["claude"])
  if (
    claude &&
    !options.hostAllowsClaudeGlobalDirectory &&
    (
      claude["includeGlobalDir"] === true ||
      (
        claude["enabled"] === true &&
        !Object.prototype.hasOwnProperty.call(claude, "includeGlobalDir")
      )
    )
  ) {
    pending.push(createPendingProjectAuthorityRequest(
      "claude-global-directory",
      {
        compatibility: {
          claude: { includeGlobalDir: true },
        },
      },
    ))
    claude["includeGlobalDir"] = false
  }

  return { safeProject, pending }
}

export function getPendingProjectAuthorityRequests(
  config: NexusConfig,
): readonly PendingProjectAuthorityRequest[] {
  return (config.pendingProjectAuthority ?? []).filter(
    isValidPendingProjectAuthorityRequest,
  )
}

function appendUnique<T>(current: T[], additions: T[]): T[] {
  const keyed = new Map<string, T>()
  for (const value of [...current, ...additions]) {
    keyed.set(stableConfigValue(value), value)
  }
  return [...keyed.values()]
}

export function applyProjectAuthorityRequest(
  config: NexusConfig,
  request: PendingProjectAuthorityRequest,
): void {
  if (!isValidPendingProjectAuthorityRequest(request)) {
    throw new Error("Cannot apply an invalid project authority request")
  }
  switch (request.kind) {
    case "model-endpoint": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["model-endpoint"]
      config.model = mergeProviderConfigSafely(
        config.model,
        payload.model as Partial<ProviderConfig>,
      )
      break
    }
    case "embeddings-endpoint": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["embeddings-endpoint"]
      config.embeddings = cloneConfigValue(payload.embeddings)
      break
    }
    case "vector-db-endpoint": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["vector-db-endpoint"]
      config.vectorDb = {
        enabled: config.vectorDb?.enabled ?? false,
        collection: config.vectorDb?.collection ?? "nexus",
        url: config.vectorDb?.url ?? "http://localhost:6333",
        autoStart: config.vectorDb?.autoStart ?? true,
        ...config.vectorDb,
        ...payload.vectorDb,
      }
      break
    }
    case "remote-skills": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["remote-skills"]
      config.skillsUrls = cloneConfigValue(payload.skillsUrls)
      break
    }
    case "custom-tools": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["custom-tools"]
      config.tools.custom = cloneConfigValue(payload.tools.custom)
      break
    }
    case "profiles": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["profiles"]
      const profiles = { ...config.profiles }
      for (const [name, patch] of Object.entries(payload.profiles)) {
        profiles[name] = mergeProviderConfigPartialSafely(
          profiles[name] ?? {},
          cloneConfigValue(patch),
        )
      }
      config.profiles = profiles
      break
    }
    case "external-skill-paths": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["external-skill-paths"]
      const current = config.skillsConfig ??
        config.skills.map((configuredPath) => ({
          path: configuredPath,
          enabled: true,
        }))
      const additions = payload.skills.map((entry) =>
        typeof entry === "string"
          ? { path: entry, enabled: true }
          : { path: entry.path, enabled: entry.enabled !== false })
      config.skillsConfig = appendUnique(current, additions)
      config.skills = config.skillsConfig
        .filter((entry) => entry.enabled)
        .map((entry) => entry.path)
      break
    }
    case "external-rule-paths": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["external-rule-paths"]
      config.rules.files = appendUnique(
        config.rules.files,
        payload.rules.files,
      )
      break
    }
    case "external-memory-path": {
      const payload =
        request.payload as ProjectAuthorityPayloadByKind["external-memory-path"]
      config.memory = {
        ...config.memory,
        autoMemoryDirectory: payload.memory.autoMemoryDirectory,
      }
      break
    }
    case "claude-global-directory": {
      config.compatibility = {
        ...config.compatibility,
        claude: {
          ...config.compatibility?.claude,
          includeGlobalDir: true,
        },
      }
      break
    }
  }
}
