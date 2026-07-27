const MAX_MCP_URL_CHARS = 8_192

/**
 * MCP remote transports and browser auth handoffs are deliberately limited to
 * HTTP(S). This prevents a config value from becoming a file/custom-protocol
 * capability when an IDE calls its external-URL API.
 */
export function parseMcpHttpUrl(
  raw: string,
  label = "MCP URL",
): URL {
  if (raw.length === 0 || raw.length > MAX_MCP_URL_CHARS) {
    throw new Error(`${label} must be a bounded HTTP(S) URL`)
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP(S), received ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`)
  }
  return parsed
}

export function isSafeMcpHttpUrl(raw: string): boolean {
  try {
    parseMcpHttpUrl(raw)
    return true
  } catch {
    return false
  }
}
