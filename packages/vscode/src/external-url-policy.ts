const MAX_EXTERNAL_URL_CHARACTERS = 4_096

/**
 * Parse a URL that may be handed to VS Code or a local integration.
 * Custom protocols and URL-embedded credentials never cross this boundary.
 */
export function parseStrictExternalHttpUrl(raw: string): URL {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > MAX_EXTERNAL_URL_CHARACTERS ||
    raw !== raw.trim() ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new Error("External URL is malformed")
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("External URL is malformed")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "External URL must be an HTTP(S) URL without embedded credentials",
    )
  }
  return url
}

export function isLoopbackExternalHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = parseStrictExternalHttpUrl(raw)
  } catch {
    return false
  }
  const hostname = url.hostname.toLowerCase()
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  )
}
