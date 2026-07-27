import * as http from "node:http"
import * as https from "node:https"
import { isIP, type LookupFunction } from "node:net"

import type {
  AuthorizedNetworkRequest,
  HostNetworkRequest,
  IHost,
  NetworkRequestPurpose,
  ResolvedNetworkAddress,
} from "../types.js"
import { isPublicNetworkAddress } from "./network-policy.js"

export type NetworkRequestErrorCode =
  | "invalid_options"
  | "invalid_url"
  | "unsupported_protocol"
  | "url_credentials"
  | "authorization_unavailable"
  | "invalid_authorization"
  | "request_too_large"
  | "response_too_large"
  | "too_many_redirects"
  | "invalid_redirect"
  | "timeout"
  | "aborted"
  | "request_failed"

export class NetworkRequestError extends Error {
  readonly code: NetworkRequestErrorCode

  constructor(code: NetworkRequestErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = "NetworkRequestError"
    this.code = code
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      })
    }
  }
}

export interface NetworkTransportRequest {
  url: string
  authorization: AuthorizedNetworkRequest
  method: string
  headers: Readonly<Record<string, string>>
  body?: Uint8Array
  maxResponseBytes: number
  signal: AbortSignal
}

export interface NetworkTransportResponse {
  status: number
  statusText: string
  headers: Readonly<Record<string, string>>
  body: Uint8Array
}

export type NetworkTransport = (
  request: NetworkTransportRequest,
) => Promise<NetworkTransportResponse>

export interface NetworkRequestOptions {
  purpose: NetworkRequestPurpose
  method?: string
  headers?: Readonly<Record<string, string>>
  body?: string | Uint8Array
  maxRedirects?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Injectable transport for deterministic, network-free tests. */
  transport?: NetworkTransport
}

export interface NetworkResourceResponse extends NetworkTransportResponse {
  /** Final URL after authorized redirects. */
  url: string
  redirectCount: number
}

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_URL_CHARACTERS = 16 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
])

function requireBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new NetworkRequestError(
      "invalid_options",
      `${name} must be a safe integer between ${minimum} and ${maximum}.`,
    )
  }
  return value
}

function canonicalUrl(raw: string): string {
  try {
    if (raw.length > MAX_URL_CHARACTERS) {
      throw new NetworkRequestError(
        "invalid_url",
        `Network request URL exceeds ${MAX_URL_CHARACTERS} characters.`,
      )
    }
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new NetworkRequestError(
        "unsupported_protocol",
        "Network requests must use HTTP(S).",
      )
    }
    if (parsed.username || parsed.password) {
      throw new NetworkRequestError(
        "url_credentials",
        "Credentials in network request URLs are not allowed.",
      )
    }
    parsed.hash = ""
    return parsed.toString()
  } catch (error) {
    if (error instanceof NetworkRequestError) throw error
    throw new NetworkRequestError(
      "invalid_url",
      "Network request contains an invalid URL.",
      error,
    )
  }
}

function normalizedHostname(url: URL): string {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname
  return hostname.toLowerCase().replace(/\.+$/, "")
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.trim().toLowerCase()
    const textValue = String(value)
    if (
      !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name) ||
      /[\r\n]/u.test(textValue)
    ) {
      throw new NetworkRequestError(
        "invalid_options",
        "Network request contains an invalid header.",
      )
    }
    if (
      !name ||
      name === "host" ||
      name === "connection" ||
      name === "transfer-encoding" ||
      name === "content-length" ||
      name === "proxy-authorization"
    ) {
      continue
    }
    normalized[name] = textValue
  }
  if (!("accept-encoding" in normalized)) {
    normalized["accept-encoding"] = "identity"
  }
  normalized.connection = "close"
  return normalized
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "cookie" ||
    lower === "cookie2" ||
    lower === "x-subscription-token" ||
    lower === "api-key" ||
    lower.endsWith("-api-key") ||
    lower.includes("token")
  )
}

function stripCrossOriginSecrets(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeader(name)),
  )
}

function dropBodyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers }
  delete next["content-length"]
  delete next["content-type"]
  delete next["content-encoding"]
  return next
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

function asBody(
  body: string | Uint8Array | undefined,
  maxRequestBytes: number,
): Uint8Array | undefined {
  const encoded =
    typeof body === "string" ? new TextEncoder().encode(body) : body
  if (encoded && encoded.byteLength > maxRequestBytes) {
    throw new NetworkRequestError(
      "request_too_large",
      `Network request body exceeds ${maxRequestBytes} bytes.`,
    )
  }
  return encoded
}

function validateAuthorization(
  expectedUrl: string,
  authorization: AuthorizedNetworkRequest,
): void {
  const expected = new URL(expectedUrl)
  const expectedHostname = normalizedHostname(expected)
  if (
    !authorization ||
    authorization.url !== expectedUrl ||
    authorization.hostname !== expectedHostname ||
    !Array.isArray(authorization.addresses) ||
    authorization.addresses.length === 0
  ) {
    throw new NetworkRequestError(
      "invalid_authorization",
      "Host returned malformed network authorization.",
    )
  }
  for (const answer of authorization.addresses) {
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      isIP(answer.address) !== answer.family ||
      !isPublicNetworkAddress(answer.address)
    ) {
      throw new NetworkRequestError(
        "invalid_authorization",
        "Host network authorization contains a non-public address.",
      )
    }
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function redirectTarget(currentUrl: string, location: string): string {
  try {
    return canonicalUrl(new URL(location, currentUrl).toString())
  } catch (error) {
    if (error instanceof NetworkRequestError) throw error
    throw new NetworkRequestError(
      "invalid_redirect",
      "Network response contains an invalid redirect location.",
      error,
    )
  }
}

export async function requestNetworkResource(
  host: IHost,
  rawUrl: string,
  options: NetworkRequestOptions,
): Promise<NetworkResourceResponse> {
  if (
    options.purpose !== "web_fetch" &&
    options.purpose !== "web_search" &&
    options.purpose !== "mcp" &&
    options.purpose !== "remote_session"
  ) {
    throw new NetworkRequestError(
      "invalid_options",
      "Network request purpose is invalid.",
    )
  }
  const maxRedirects = requireBoundedInteger(
    "maxRedirects",
    options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    0,
    20,
  )
  const maxRequestBytes = requireBoundedInteger(
    "maxRequestBytes",
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    1,
    16 * 1024 * 1024,
  )
  const maxResponseBytes = requireBoundedInteger(
    "maxResponseBytes",
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    64 * 1024 * 1024,
  )
  const timeoutMs = requireBoundedInteger(
    "timeoutMs",
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    5 * 60_000,
  )
  if (typeof host.authorizeNetworkRequest !== "function") {
    throw new NetworkRequestError(
      "authorization_unavailable",
      "Host network authorization capability is unavailable.",
    )
  }

  let currentUrl = canonicalUrl(rawUrl)
  let method = (options.method ?? "GET").trim().toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new NetworkRequestError(
      "invalid_options",
      "Network request method is not allowed.",
    )
  }
  let headers = normalizeHeaders(options.headers)
  let body = asBody(options.body, maxRequestBytes)
  if (body) headers["content-length"] = String(body.byteLength)

  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason)
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error("Network request timed out."))
  }, timeoutMs)
  timer.unref?.()

  const transport = options.transport ?? nodePinnedTransport
  let redirectCount = 0
  try {
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason
      const authorizationRequest: HostNetworkRequest = {
        url: currentUrl,
        purpose: options.purpose,
      }
      let authorization: AuthorizedNetworkRequest
      try {
        authorization = await raceWithAbort(
          host.authorizeNetworkRequest(authorizationRequest),
          controller.signal,
        )
      } catch (error) {
        if (error instanceof Error && error.name === "NetworkPolicyError") {
          throw error
        }
        throw new NetworkRequestError(
          "authorization_unavailable",
          "Host network authorization failed.",
          error,
        )
      }
      validateAuthorization(currentUrl, authorization)

      if (controller.signal.aborted) throw controller.signal.reason
      const response = await raceWithAbort(
        transport({
          url: currentUrl,
          authorization,
          method,
          headers,
          body,
          maxResponseBytes,
          signal: controller.signal,
        }),
        controller.signal,
      )
      if (response.body.byteLength > maxResponseBytes) {
        throw new NetworkRequestError(
          "response_too_large",
          `Network response exceeds ${maxResponseBytes} bytes.`,
        )
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        return {
          ...response,
          url: currentUrl,
          redirectCount,
        }
      }

      const location = headerValue(response.headers, "location")
      if (!location) {
        return {
          ...response,
          url: currentUrl,
          redirectCount,
        }
      }
      if (redirectCount >= maxRedirects) {
        throw new NetworkRequestError(
          "too_many_redirects",
          `Network request exceeded ${maxRedirects} redirects.`,
        )
      }

      const nextUrl = redirectTarget(currentUrl, location)
      const currentOrigin = new URL(currentUrl).origin
      const nextOrigin = new URL(nextUrl).origin
      if (currentOrigin !== nextOrigin) {
        headers = stripCrossOriginSecrets(headers)
      }

      const rewriteToGet =
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      if (rewriteToGet) {
        method = "GET"
        body = undefined
        headers = dropBodyHeaders(headers)
      }

      currentUrl = nextUrl
      redirectCount++
    }
  } catch (error) {
    if (timedOut) {
      throw new NetworkRequestError(
        "timeout",
        `Network request timed out after ${timeoutMs}ms.`,
        error,
      )
    }
    if (options.signal?.aborted) {
      throw new NetworkRequestError(
        "aborted",
        "Network request was cancelled.",
        error,
      )
    }
    if (
      error instanceof NetworkRequestError ||
      (error instanceof Error && error.name === "NetworkPolicyError")
    ) {
      throw error
    }
    throw new NetworkRequestError(
      "request_failed",
      "Network request failed.",
      error,
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onCallerAbort)
  }
}

function responseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ")
  }
  return result
}

function selectPinnedAddress(
  addresses: readonly ResolvedNetworkAddress[],
  family: number | undefined,
): ResolvedNetworkAddress | undefined {
  if (family === 4 || family === 6) {
    return addresses.find((answer) => answer.family === family)
  }
  return addresses[0]
}

/**
 * Node transport with DNS pinning. The host resolves and authorizes every
 * address first; this lookup callback returns only those exact addresses to
 * the socket, closing the DNS-rebinding window between validation and connect.
 * A fresh, non-pooled connection is used for every hop.
 */
export const nodePinnedTransport: NetworkTransport = async ({
  url,
  authorization,
  method,
  headers,
  body,
  maxResponseBytes,
  signal,
}) => new Promise<NetworkTransportResponse>((resolve, reject) => {
  const parsed = new URL(url)
  const expectedHostname = authorization.hostname
  let settled = false
  const finishReject = (error: unknown) => {
    if (settled) return
    settled = true
    reject(error)
  }
  const lookupPinned: LookupFunction = (hostname, lookupOptions, callback) => {
    const requestedHostname = hostname.toLowerCase().replace(/\.+$/, "")
    if (requestedHostname !== expectedHostname) {
      callback(
        Object.assign(new Error("Pinned network hostname mismatch."), {
          code: "ERR_NETWORK_HOST_MISMATCH",
        }),
        "",
      )
      return
    }
    const rawRequestedFamily =
      typeof lookupOptions === "object" ? lookupOptions.family : undefined
    const requestedFamily =
      rawRequestedFamily === 4 || rawRequestedFamily === "IPv4"
        ? 4
        : rawRequestedFamily === 6 || rawRequestedFamily === "IPv6"
          ? 6
          : undefined
    if (
      typeof lookupOptions === "object" &&
      "all" in lookupOptions &&
      lookupOptions.all
    ) {
      const compatible = authorization.addresses.filter((answer) =>
        requestedFamily === 4 || requestedFamily === 6
          ? answer.family === requestedFamily
          : true
      )
      if (compatible.length === 0) {
        callback(
          Object.assign(new Error("No authorized address for requested family."), {
            code: "ENOTFOUND",
          }),
          "",
        )
        return
      }
      callback(null, compatible.map((answer) => ({ ...answer })))
      return
    }
    const selected = selectPinnedAddress(
      authorization.addresses,
      requestedFamily,
    )
    if (!selected) {
      callback(
        Object.assign(new Error("No authorized address for requested family."), {
          code: "ENOTFOUND",
        }),
        "",
      )
      return
    }
    callback(null, selected.address, selected.family)
  }

  const requestFn = parsed.protocol === "https:" ? https.request : http.request
  const request = requestFn({
    protocol: parsed.protocol,
    hostname: normalizedHostname(parsed),
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method,
    headers,
    lookup: lookupPinned,
    agent: false,
    signal,
  }, (incoming) => {
    const declaredLength = incoming.headers["content-length"]
    if (
      typeof declaredLength === "string" &&
      /^\d+$/u.test(declaredLength) &&
      Number(declaredLength) > maxResponseBytes
    ) {
      incoming.destroy()
      finishReject(new NetworkRequestError(
        "response_too_large",
        `Network response exceeds ${maxResponseBytes} bytes.`,
      ))
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.byteLength
      if (total > maxResponseBytes) {
        incoming.destroy()
        finishReject(new NetworkRequestError(
          "response_too_large",
          `Network response exceeds ${maxResponseBytes} bytes.`,
        ))
        return
      }
      chunks.push(bytes)
    })
    incoming.on("error", finishReject)
    incoming.on("end", () => {
      if (settled) return
      settled = true
      resolve({
        status: incoming.statusCode ?? 0,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming.headers),
        body: Buffer.concat(chunks, total),
      })
    })
  })
  request.on("error", finishReject)
  if (body) request.write(body)
  request.end()
})
