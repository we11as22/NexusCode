import { QdrantClient } from "@qdrant/js-client-rest"

/**
 * Normalizes user-provided Qdrant URL (scheme/host/port).
 */
export function parseQdrantUrl(url: string | undefined): string {
  if (!url || url.trim() === "") {
    return "http://localhost:6333"
  }
  const trimmed = url.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const candidate = hasScheme ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (!hasScheme && !parsed.port) parsed.port = "6333"
    const pathname = parsed.pathname.replace(/\/+$/, "")
    parsed.pathname = pathname || "/"
    const normalized = parsed.toString()
    return parsed.pathname === "/"
      ? normalized.replace(/\/$/, "")
      : normalized.replace(/\/+$/, "")
  } catch {
    return candidate
  }
}

/**
 * Qdrant client with host/port/https/prefix handling (works behind path-prefixed proxies and Qdrant Cloud).
 */
export function createQdrantClient(url: string, apiKey?: string): QdrantClient {
  const parsedUrl = parseQdrantUrl(url)
  try {
    const urlObj = new URL(parsedUrl)
    let port: number
    let useHttps: boolean
    if (urlObj.port) {
      port = Number(urlObj.port)
      useHttps = urlObj.protocol === "https:"
    } else if (urlObj.protocol === "https:") {
      port = 443
      useHttps = true
    } else {
      port = 80
      useHttps = false
    }
    const prefix = urlObj.pathname === "/" ? undefined : urlObj.pathname.replace(/\/+$/, "")
    return new QdrantClient({
      host: urlObj.hostname,
      https: useHttps,
      port,
      prefix,
      apiKey: apiKey || undefined,
      checkCompatibility: false,
      headers: {
        "User-Agent": "NexusCode",
      },
    })
  } catch {
    return new QdrantClient({
      url: parsedUrl,
      apiKey: apiKey || undefined,
      checkCompatibility: false,
      headers: {
        "User-Agent": "NexusCode",
      },
    })
  }
}
