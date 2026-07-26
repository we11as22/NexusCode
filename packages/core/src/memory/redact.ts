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
