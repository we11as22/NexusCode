const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?:password|passphrase|api[_ -]?key|client[_ -]?secret|access[_ -]?key|private[_ -]?key|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
]

const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi
const MAX_METADATA_DEPTH = 12
const MAX_METADATA_NODES = 2_048
const MAX_METADATA_ARRAY_ITEMS = 256
const MAX_METADATA_OBJECT_KEYS = 256
const MAX_METADATA_KEY_CHARS = 256
const MAX_METADATA_STRING_CHARS = 16_384
const MAX_METADATA_APPROX_CHARS = 64 * 1_024
const DANGEROUS_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"])
const SENSITIVE_METADATA_KEYS = new Set([
  "accesskey",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "clientsecret",
  "credential",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "token",
])

export class MemoryValueLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryValueLimitError"
  }
}

function redactCredentialUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    if (!parsed.username && !parsed.password) return raw
    if (parsed.username === "git" && !parsed.password) return raw
    const authorityStart = raw.indexOf("//") + 2
    const authorityEnd = raw.slice(authorityStart).search(/[/?#]/)
    const end = authorityEnd < 0 ? raw.length : authorityStart + authorityEnd
    const authority = raw.slice(authorityStart, end)
    const at = authority.lastIndexOf("@")
    if (at <= 0) return raw
    return `${raw.slice(0, authorityStart)}[redacted]@${authority.slice(at + 1)}${raw.slice(end)}`
  } catch {
    return raw.replace(/:\/\/[^/\s@]+@/, "://[redacted]@")
  }
}

export function redactMemorySecrets(input: string): { text: string; redacted: boolean } {
  let text = input.replace(URL_CANDIDATE, redactCredentialUrl)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]")
  return { text, redacted: text !== input }
}

function sensitiveMetadataKey(input: string): boolean {
  const normalized = input.replace(/[_\s.-]/g, "").toLowerCase()
  if (SENSITIVE_METADATA_KEYS.has(normalized)) return true
  return [...SENSITIVE_METADATA_KEYS].some((key) => normalized.endsWith(key))
}

export interface SanitizedMemoryValue<T = unknown> {
  value: T
  redacted: boolean
}

/**
 * Convert memory metadata/source payloads into bounded JSON while removing
 * credentials from both values and credential-named fields.
 *
 * Strict mode is for new writes and rejects lossy coercion. Tolerant mode is
 * for legacy reads: it deterministically bounds malformed historic values so
 * one old record cannot grow prompts or snapshots without limit.
 */
export function sanitizeMemoryValue<T>(
  input: T,
  options: { strict?: boolean; label?: string } = {},
): SanitizedMemoryValue<T> {
  const strict = options.strict === true
  const label = options.label ?? "memory value"
  const seen = new WeakSet<object>()
  let nodes = 0
  let approximateChars = 0
  let redacted = false

  const failOrReplace = (message: string, replacement: unknown): unknown => {
    if (strict) throw new MemoryValueLimitError(`${label} ${message}`)
    redacted = true
    return replacement
  }
  const account = (characters: number): boolean => {
    approximateChars += characters
    if (approximateChars <= MAX_METADATA_APPROX_CHARS) return true
    if (strict) {
      throw new MemoryValueLimitError(
        `${label} exceeded ${MAX_METADATA_APPROX_CHARS} approximate characters`,
      )
    }
    redacted = true
    return false
  }

  const visit = (value: unknown, depth: number, key?: string): unknown => {
    nodes += 1
    if (nodes > MAX_METADATA_NODES) {
      return failOrReplace(
        `exceeded ${MAX_METADATA_NODES} nodes`,
        "[truncated]",
      )
    }
    if (depth > MAX_METADATA_DEPTH) {
      return failOrReplace(
        `exceeded depth ${MAX_METADATA_DEPTH}`,
        "[truncated]",
      )
    }
    if (key && sensitiveMetadataKey(key)) {
      redacted = true
      if (!account(10)) return "[truncated]"
      return "[redacted]"
    }
    if (typeof value === "string") {
      let bounded = value
      if (bounded.length > MAX_METADATA_STRING_CHARS) {
        bounded = failOrReplace(
          `contains a string longer than ${MAX_METADATA_STRING_CHARS} characters`,
          `${bounded.slice(0, MAX_METADATA_STRING_CHARS - 12)}…[truncated]`,
        ) as string
      }
      const sanitized = redactMemorySecrets(bounded)
      redacted ||= sanitized.redacted
      if (!account(sanitized.text.length)) return "[truncated]"
      return sanitized.text
    }
    if (value === null || typeof value === "boolean") {
      if (!account(8)) return null
      return value
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return failOrReplace("contains a non-finite number", null)
      }
      if (!account(24)) return null
      return value
    }
    if (typeof value !== "object") {
      return failOrReplace("contains a non-JSON value", null)
    }
    if (seen.has(value)) {
      return failOrReplace("contains a cyclic value", "[cycle]")
    }
    seen.add(value)

    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_METADATA_ARRAY_ITEMS)
      if (value.length > length) {
        failOrReplace(
          `contains an array larger than ${MAX_METADATA_ARRAY_ITEMS} items`,
          null,
        )
      }
      return value.slice(0, length).map((item) => visit(item, depth + 1))
    }

    const entries = Object.entries(value as Record<string, unknown>)
    const length = Math.min(entries.length, MAX_METADATA_OBJECT_KEYS)
    if (entries.length > length) {
      failOrReplace(
        `contains an object larger than ${MAX_METADATA_OBJECT_KEYS} keys`,
        null,
      )
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const [rawKey, item] of entries.slice(0, length)) {
      if (DANGEROUS_METADATA_KEYS.has(rawKey)) {
        failOrReplace(`contains forbidden key "${rawKey}"`, null)
        continue
      }
      let boundedKey = rawKey
      if (boundedKey.length > MAX_METADATA_KEY_CHARS) {
        boundedKey = failOrReplace(
          `contains a key longer than ${MAX_METADATA_KEY_CHARS} characters`,
          boundedKey.slice(0, MAX_METADATA_KEY_CHARS),
        ) as string
      }
      if (!account(boundedKey.length)) break
      result[boundedKey] = visit(item, depth + 1, boundedKey)
    }
    return result
  }

  const value = visit(input, 0)
  return { value: value as T, redacted }
}
