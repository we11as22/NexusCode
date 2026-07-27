import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import * as http from "node:http"
import * as https from "node:https"
import { isIP, type LookupFunction } from "node:net"
import { Readable } from "node:stream"

import { isPublicNetworkAddress } from "../network/network-policy.js"
import type {
  AuthorizedNetworkRequest,
  ResolvedNetworkAddress,
} from "../types.js"
import type { McpRemoteRequestAuthorizer } from "./types.js"

export interface McpRemoteFetchHopRequest {
  url: string
  authorization: AuthorizedNetworkRequest
  method: string
  headers: Readonly<Record<string, string>>
  body?: Uint8Array
  signal: AbortSignal
}

export type McpRemoteFetchHop = (
  request: McpRemoteFetchHopRequest,
) => Promise<Response>

export interface McpAuthorizedFetchOptions {
  /** Injectable hop transport for deterministic, network-free tests. */
  hop?: McpRemoteFetchHop
  maxRedirects?: number
  maxRequestBytes?: number
  maxRequestHeaders?: number
  maxRequestHeaderBytes?: number
  maxResponseHeaders?: number
  maxResponseHeaderBytes?: number
  /** Maximum bytes in a finite (for example JSON) response body. */
  maxResponseBytes?: number
  /** Maximum raw bytes in one SSE record; the stream lifetime is unbounded. */
  maxSseEventBytes?: number
}

export type McpNodeRequestFactory = (
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest

export interface McpPinnedNodeHopOptions {
  httpRequest?: McpNodeRequestFactory
  httpsRequest?: McpNodeRequestFactory
  maxResponseHeaders?: number
  maxResponseHeaderBytes?: number
}

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
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_REQUEST_HEADERS = 128
const DEFAULT_MAX_REQUEST_HEADER_BYTES = 64 * 1024
const DEFAULT_MAX_RESPONSE_HEADERS = 256
const DEFAULT_MAX_RESPONSE_HEADER_BYTES = 64 * 1024
// One result may legitimately contain 16 MiB of decoded binary payload plus
// base64 expansion, text, and its JSON-RPC envelope.
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_SSE_EVENT_BYTES = 32 * 1024 * 1024
const MAX_URL_CHARACTERS = 16 * 1024
const MAX_AUTHORIZED_ADDRESSES = 32

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
    throw new Error(
      `${name} must be a safe integer between ${minimum} and ${maximum}`,
    )
  }
  return value
}

function canonicalUrl(raw: string): string {
  if (raw.length > MAX_URL_CHARACTERS) {
    throw new Error(
      `Remote MCP URL exceeds ${MAX_URL_CHARACTERS} characters`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error("Remote MCP request contains an invalid URL", {
      cause: error,
    })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote MCP requests must use HTTP(S)")
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials in remote MCP URLs are not allowed")
  }
  parsed.hash = ""
  return parsed.toString()
}

function normalizedHostname(url: URL): string {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname
  return hostname.toLowerCase().replace(/\.+$/u, "")
}

function normalizedIpLiteral(address: string): string {
  if (isIP(address) !== 6) return address
  return normalizedHostname(new URL(`http://[${address}]/`))
}

function validatedAuthorization(
  expectedUrl: string,
  authorization: AuthorizedNetworkRequest,
): AuthorizedNetworkRequest {
  const expectedHostname = normalizedHostname(new URL(expectedUrl))
  if (
    !authorization ||
    authorization.url !== expectedUrl ||
    authorization.hostname !== expectedHostname ||
    !Array.isArray(authorization.addresses) ||
    authorization.addresses.length === 0 ||
    authorization.addresses.length > MAX_AUTHORIZED_ADDRESSES
  ) {
    throw new Error("Remote MCP network authorization is malformed")
  }
  for (const answer of authorization.addresses) {
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      isIP(answer.address) !== answer.family ||
      !isPublicNetworkAddress(answer.address)
    ) {
      throw new Error(
        "Remote MCP network authorization contains a non-public address",
      )
    }
  }

  // Node does not invoke lookup() for an IP-literal URL. Ensure that direct
  // socket target was explicitly authorized rather than trusting only the
  // authorizer's hostname label.
  const literalFamily = isIP(expectedHostname)
  if (
    literalFamily !== 0 &&
    !authorization.addresses.some(
      ({ address, family }) =>
        family === literalFamily &&
        normalizedIpLiteral(address) === expectedHostname,
    )
  ) {
    throw new Error(
      "Remote MCP network authorization does not include the IP literal",
    )
  }
  return Object.freeze({
    url: authorization.url,
    hostname: authorization.hostname,
    addresses: Object.freeze(
      authorization.addresses.map(({ address, family }) =>
        Object.freeze({ address, family })
      ),
    ),
  })
}

function normalizedHeaders(
  init: RequestInit["headers"] | undefined,
): Record<string, string> {
  let headers: Headers
  try {
    headers = new Headers(init)
  } catch (error) {
    throw new Error("Remote MCP request contains an invalid header", {
      cause: error,
    })
  }
  const normalized: Record<string, string> = {}
  headers.forEach((value, name) => {
    normalized[name] = value
  })
  for (const name of [
    "host",
    "connection",
    "proxy-connection",
    "transfer-encoding",
    "content-length",
    "proxy-authorization",
    "keep-alive",
    "upgrade",
    "expect",
    "te",
    "trailer",
  ]) {
    delete normalized[name]
  }
  // The transport deliberately does not transparently decompress bodies.
  // This keeps the bytes exposed through Response consistent with headers.
  normalized["accept-encoding"] = "identity"
  normalized.connection = "close"
  return normalized
}

function validateHeaderBounds(
  headers: Readonly<Record<string, string>>,
  maxHeaders: number,
  maxHeaderBytes: number,
): void {
  const entries = Object.entries(headers)
  if (entries.length > maxHeaders) {
    throw new Error(`Remote MCP request exceeds ${maxHeaders} headers`)
  }
  let totalBytes = 2
  for (const [name, value] of entries) {
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (totalBytes > maxHeaderBytes) {
      throw new Error(
        `Remote MCP request headers exceed ${maxHeaderBytes} bytes`,
      )
    }
  }
}

async function asBody(
  rawBody: RequestInit["body"],
  headers: Record<string, string>,
  maxRequestBytes: number,
): Promise<Uint8Array | undefined> {
  if (rawBody === undefined || rawBody === null) return undefined

  let body: Uint8Array
  if (typeof rawBody === "string") {
    body = new TextEncoder().encode(rawBody)
  } else if (rawBody instanceof URLSearchParams) {
    body = new TextEncoder().encode(rawBody.toString())
    headers["content-type"] ??=
      "application/x-www-form-urlencoded;charset=UTF-8"
  } else if (rawBody instanceof Blob) {
    if (rawBody.size > maxRequestBytes) {
      throw new Error(
        `Remote MCP request body exceeds ${maxRequestBytes} bytes`,
      )
    }
    body = new Uint8Array(await rawBody.arrayBuffer())
    if (rawBody.type) headers["content-type"] ??= rawBody.type
  } else if (rawBody instanceof ArrayBuffer) {
    body = new Uint8Array(rawBody.slice(0))
  } else if (ArrayBuffer.isView(rawBody)) {
    body = Uint8Array.from(
      new Uint8Array(
        rawBody.buffer,
        rawBody.byteOffset,
        rawBody.byteLength,
      ),
    )
  } else {
    throw new Error(
      "Remote MCP request body must be buffered; streaming and FormData bodies are not supported",
    )
  }

  if (body.byteLength > maxRequestBytes) {
    throw new Error(
      `Remote MCP request body exceeds ${maxRequestBytes} bytes`,
    )
  }
  return body
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

function withoutCrossOriginSecrets(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeader(name)),
  )
}

function withoutBodyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers }
  delete next["content-length"]
  delete next["content-type"]
  delete next["content-encoding"]
  return next
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("Remote MCP request was aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void promise.then(onLateValue, () => undefined)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        if (settled) {
          onLateValue?.(value)
          return
        }
        settled = true
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        if (settled) return
        settled = true
        reject(error)
      },
    )
  })
}

async function releaseResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being discarded. Socket/stream cancellation is best
    // effort and must not mask the redirect or abort reason.
  }
}

function withResponseMetadata(
  response: Response,
  url: string,
  redirected: boolean,
): Response {
  Object.defineProperties(response, {
    redirected: { configurable: true, value: redirected },
    url: { configurable: true, value: url },
  })
  return response
}

function isSseResponse(response: Response): boolean {
  return response.ok && response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "text/event-stream"
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length")
  if (raw === null) return undefined
  const normalized = raw.trim()
  if (!/^\d+$/u.test(normalized)) {
    throw new Error("Remote MCP response has an invalid Content-Length")
  }
  const length = Number(normalized)
  if (!Number.isSafeInteger(length)) {
    throw new Error("Remote MCP response has an invalid Content-Length")
  }
  return length
}

interface SseRecordCounter {
  recordBytes: number
  lineBytes: number
  previousWasCr: boolean
  previousCrEndedBlankLine: boolean
}

function sseChunkExceedsLimit(
  bytes: Uint8Array,
  state: SseRecordCounter,
  maximum: number,
): boolean {
  for (const byte of bytes) {
    state.recordBytes += 1

    if (byte === 0x0a && state.previousWasCr) {
      // CRLF is one line ending. If CR completed the blank separator, the
      // following LF belongs to that separator rather than the next event.
      state.previousWasCr = false
      if (state.previousCrEndedBlankLine) {
        state.recordBytes = 0
      } else if (state.recordBytes > maximum) {
        return true
      }
      state.previousCrEndedBlankLine = false
      continue
    }

    if (byte === 0x0d || byte === 0x0a) {
      if (state.recordBytes > maximum) return true
      const blankLine = state.lineBytes === 0
      state.lineBytes = 0
      state.previousWasCr = byte === 0x0d
      state.previousCrEndedBlankLine = blankLine && byte === 0x0d
      if (blankLine) state.recordBytes = 0
      continue
    }

    state.previousWasCr = false
    state.previousCrEndedBlankLine = false
    state.lineBytes += 1
    if (state.recordBytes > maximum) return true
  }
  return false
}

async function boundedAbortableResponse(
  response: Response,
  url: string,
  redirected: boolean,
  signal: AbortSignal,
  maxResponseBytes: number,
  maxSseEventBytes: number,
): Promise<Response> {
  if (signal.aborted) {
    void releaseResponse(response)
    throw abortReason(signal)
  }
  if (!response.body) return withResponseMetadata(response, url, redirected)
  const sse = isSseResponse(response)
  if (!sse) {
    let declared: number | undefined
    try {
      declared = declaredContentLength(response)
    } catch (error) {
      void releaseResponse(response)
      throw error
    }
    if (declared !== undefined && declared > maxResponseBytes) {
      void releaseResponse(response)
      throw new Error(
        `Remote MCP response body exceeds ${maxResponseBytes} bytes`,
      )
    }
  }

  const reader = response.body.getReader()
  let responseBytes = 0
  const sseCounter: SseRecordCounter = {
    recordBytes: 0,
    lineBytes: 0,
    previousWasCr: false,
    previousCrEndedBlankLine: false,
  }
  let finished = false
  let outputController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined
  const cleanup = () => {
    if (finished) return
    finished = true
    signal.removeEventListener("abort", onAbort)
  }
  const onAbort = () => {
    if (finished) return
    const reason = abortReason(signal)
    cleanup()
    void reader.cancel(reason).catch(() => undefined)
    try {
      outputController?.error(reason)
    } catch {
      // Stream may have completed between the abort event and this callback.
    }
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    },
    async pull(controller) {
      try {
        const item = await reader.read()
        if (item.done) {
          cleanup()
          controller.close()
          return
        }
        const overLimit = sse
          ? sseChunkExceedsLimit(
              item.value,
              sseCounter,
              maxSseEventBytes,
            )
          : (responseBytes += item.value.byteLength) > maxResponseBytes
        if (overLimit) {
          const error = new Error(
            sse
              ? `Remote MCP SSE event exceeds ${maxSseEventBytes} bytes`
              : `Remote MCP response body exceeds ${maxResponseBytes} bytes`,
          )
          cleanup()
          controller.error(error)
          void reader.cancel(error).catch(() => undefined)
          return
        }
        controller.enqueue(item.value)
      } catch (error) {
        cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cleanup()
      await reader.cancel(reason)
    },
  })
  return withResponseMetadata(new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }), url, redirected)
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
 * Build a Node lookup function which never consults DNS. It returns only the
 * host-authorized answers for the exact hostname of this request hop.
 */
export function createMcpPinnedLookup(
  authorization: AuthorizedNetworkRequest,
): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    const requestedHostname = hostname.toLowerCase().replace(/\.+$/u, "")
    if (requestedHostname !== authorization.hostname) {
      callback(
        Object.assign(new Error("Pinned MCP hostname mismatch"), {
          code: "ERR_MCP_HOST_MISMATCH",
        }),
        "",
      )
      return
    }
    const rawFamily =
      typeof lookupOptions === "object" ? lookupOptions.family : undefined
    const requestedFamily =
      rawFamily === 4 || rawFamily === "IPv4"
        ? 4
        : rawFamily === 6 || rawFamily === "IPv6"
          ? 6
          : undefined
    if (
      typeof lookupOptions === "object" &&
      "all" in lookupOptions &&
      lookupOptions.all
    ) {
      const compatible = authorization.addresses.filter((answer) =>
        requestedFamily === undefined || answer.family === requestedFamily
      )
      if (compatible.length === 0) {
        callback(
          Object.assign(
            new Error("No authorized MCP address for requested family"),
            { code: "ENOTFOUND" },
          ),
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
        Object.assign(
          new Error("No authorized MCP address for requested family"),
          { code: "ENOTFOUND" },
        ),
        "",
      )
      return
    }
    callback(null, selected.address, selected.family)
  }
}

function responseHeaderBytes(incoming: http.IncomingMessage): number {
  if (Array.isArray(incoming.rawHeaders)) {
    let bytes = 2
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      bytes +=
        Buffer.byteLength(incoming.rawHeaders[index] ?? "") +
        Buffer.byteLength(incoming.rawHeaders[index + 1] ?? "") +
        4
    }
    return bytes
  }
  return Object.entries(incoming.headers).reduce(
    (total, [name, value]) =>
      total +
      Buffer.byteLength(name) +
      Buffer.byteLength(
        Array.isArray(value) ? value.join(", ") : (value ?? ""),
      ) +
      4,
    2,
  )
}

function responseHeaders(incoming: http.IncomingMessage): Headers {
  const headers = new Headers()
  if (incoming.rawHeaders.length > 0) {
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      headers.append(
        incoming.rawHeaders[index] ?? "",
        incoming.rawHeaders[index + 1] ?? "",
      )
    }
    return headers
  }
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.append(name, value)
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    }
  }
  return headers
}

/**
 * Streaming Node HTTP(S) hop with DNS pinning. The original hostname remains
 * in the request options for Host/TLS certificate validation, while lookup()
 * can return only addresses authorized for this exact URL.
 */
export function createNodePinnedMcpFetchHop(
  options: McpPinnedNodeHopOptions = {},
): McpRemoteFetchHop {
  const maxResponseHeaders = requireBoundedInteger(
    "maxResponseHeaders",
    options.maxResponseHeaders ?? DEFAULT_MAX_RESPONSE_HEADERS,
    1,
    1024,
  )
  const maxResponseHeaderBytes = requireBoundedInteger(
    "maxResponseHeaderBytes",
    options.maxResponseHeaderBytes ?? DEFAULT_MAX_RESPONSE_HEADER_BYTES,
    1024,
    1024 * 1024,
  )
  const httpRequest =
    options.httpRequest ?? (http.request as McpNodeRequestFactory)
  const httpsRequest =
    options.httpsRequest ?? (https.request as McpNodeRequestFactory)

  return async ({
    url,
    authorization,
    method,
    headers,
    body,
    signal,
  }) => new Promise<Response>((resolve, reject) => {
    throwIfAborted(signal)
    const parsed = new URL(url)
    const requestFactory =
      parsed.protocol === "https:" ? httpsRequest : httpRequest
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    try {
      const request = requestFactory({
        protocol: parsed.protocol,
        hostname: normalizedHostname(parsed),
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { ...headers },
        lookup: createMcpPinnedLookup(authorization),
        agent: false,
        signal,
        maxHeaderSize: maxResponseHeaderBytes,
      }, (incoming) => {
        if (settled) {
          incoming.destroy()
          return
        }
        const headerCount = Math.ceil(incoming.rawHeaders.length / 2)
        if (
          headerCount > maxResponseHeaders ||
          responseHeaderBytes(incoming) > maxResponseHeaderBytes
        ) {
          incoming.destroy()
          fail(new Error("Remote MCP response headers exceed configured limits"))
          return
        }
        const status = incoming.statusCode ?? 0
        if (status < 200 || status > 599) {
          incoming.destroy()
          fail(new Error(`Remote MCP response has invalid status ${status}`))
          return
        }

        const bodyless =
          method === "HEAD" ||
          status === 204 ||
          status === 205 ||
          status === 304
        if (bodyless) incoming.resume()
        const stream = bodyless
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        try {
          const response = new Response(stream, {
            status,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders(incoming),
          })
          settled = true
          resolve(response)
        } catch (error) {
          incoming.destroy()
          fail(error)
        }
      })
      request.maxHeadersCount = maxResponseHeaders
      request.once("error", fail)
      if (body) request.write(body)
      request.end()
    } catch (error) {
      fail(error)
    }
  })
}

export function createMcpAuthorizedFetch(
  authorize: McpRemoteRequestAuthorizer,
  options: McpAuthorizedFetchOptions = {},
): FetchLike {
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
    64 * 1024 * 1024,
  )
  const maxRequestHeaders = requireBoundedInteger(
    "maxRequestHeaders",
    options.maxRequestHeaders ?? DEFAULT_MAX_REQUEST_HEADERS,
    1,
    1024,
  )
  const maxRequestHeaderBytes = requireBoundedInteger(
    "maxRequestHeaderBytes",
    options.maxRequestHeaderBytes ?? DEFAULT_MAX_REQUEST_HEADER_BYTES,
    16,
    1024 * 1024,
  )
  const maxResponseHeaders = requireBoundedInteger(
    "maxResponseHeaders",
    options.maxResponseHeaders ?? DEFAULT_MAX_RESPONSE_HEADERS,
    1,
    1024,
  )
  const maxResponseHeaderBytes = requireBoundedInteger(
    "maxResponseHeaderBytes",
    options.maxResponseHeaderBytes ?? DEFAULT_MAX_RESPONSE_HEADER_BYTES,
    1024,
    1024 * 1024,
  )
  const maxResponseBytes = requireBoundedInteger(
    "maxResponseBytes",
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    128 * 1024 * 1024,
  )
  const maxSseEventBytes = requireBoundedInteger(
    "maxSseEventBytes",
    options.maxSseEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES,
    1,
    128 * 1024 * 1024,
  )
  const hop = options.hop ?? createNodePinnedMcpFetchHop({
    maxResponseHeaders,
    maxResponseHeaderBytes,
  })

  return async (input, init = {}) => {
    const signal = init.signal ?? new AbortController().signal
    throwIfAborted(signal)
    let url = canonicalUrl(input.toString())
    let method = (init.method ?? "GET").trim().toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Remote MCP request method ${method} is not allowed`)
    }
    let headers = normalizedHeaders(init.headers)
    let body = await asBody(init.body, headers, maxRequestBytes)
    if (body && (method === "GET" || method === "HEAD")) {
      throw new Error(`Remote MCP ${method} requests cannot contain a body`)
    }
    if (body) headers["content-length"] = String(body.byteLength)
    validateHeaderBounds(
      headers,
      maxRequestHeaders,
      maxRequestHeaderBytes,
    )

    for (let redirectCount = 0; ; redirectCount += 1) {
      throwIfAborted(signal)
      const authorized = await raceWithAbort(
        Promise.resolve().then(() => authorize({ url, signal })),
        signal,
      )
      const authorization = validatedAuthorization(url, authorized)
      throwIfAborted(signal)
      const response = await raceWithAbort(
        Promise.resolve().then(() => hop({
          url,
          authorization,
          method,
          headers,
          ...(body ? { body } : {}),
          signal,
        })),
        signal,
        (lateResponse) => {
          void releaseResponse(lateResponse)
        },
      )
      if (!REDIRECT_STATUSES.has(response.status)) {
        return boundedAbortableResponse(
          response,
          url,
          redirectCount > 0,
          signal,
          maxResponseBytes,
          maxSseEventBytes,
        )
      }
      if (init.redirect === "manual") {
        return boundedAbortableResponse(
          response,
          url,
          redirectCount > 0,
          signal,
          maxResponseBytes,
          maxSseEventBytes,
        )
      }
      if (init.redirect === "error") {
        await releaseResponse(response)
        throw new Error("Remote MCP redirect is not allowed for this request")
      }
      if (redirectCount >= maxRedirects) {
        await releaseResponse(response)
        throw new Error(
          `Remote MCP request exceeded ${maxRedirects} redirects`,
        )
      }
      const location = response.headers.get("location")
      if (!location) {
        return boundedAbortableResponse(
          response,
          url,
          redirectCount > 0,
          signal,
          maxResponseBytes,
          maxSseEventBytes,
        )
      }
      const nextUrl = canonicalUrl(new URL(location, url).toString())
      if (new URL(nextUrl).origin !== new URL(url).origin) {
        headers = withoutCrossOriginSecrets(headers)
      }
      const rewriteToGet =
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      if (rewriteToGet) {
        method = "GET"
        body = undefined
        headers = withoutBodyHeaders(headers)
      }
      validateHeaderBounds(
        headers,
        maxRequestHeaders,
        maxRequestHeaderBytes,
      )
      await releaseResponse(response)
      url = nextUrl
    }
  }
}
