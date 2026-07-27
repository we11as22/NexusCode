import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http"
import { PassThrough } from "node:stream"

import type { AuthorizedNetworkRequest } from "../types.js"
import {
  createMcpAuthorizedFetch,
  createMcpPinnedLookup,
  createNodePinnedMcpFetchHop,
  type McpNodeRequestFactory,
  type McpRemoteFetchHop,
  type McpRemoteFetchHopRequest,
} from "./authorized-fetch.js"
import type { McpRemoteRequestAuthorizer } from "./types.js"

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 as const }

function authorization(
  url: string,
  addresses: AuthorizedNetworkRequest["addresses"] = [PUBLIC_V4],
): AuthorizedNetworkRequest {
  const parsed = new URL(url)
  return {
    url,
    hostname: parsed.hostname.toLowerCase().replace(/\.+$/u, ""),
    addresses,
  }
}

function bodyText(body: Uint8Array | undefined): string | undefined {
  return body ? new TextDecoder().decode(body) : undefined
}

describe("authorized remote MCP fetch", () => {
  it("reauthorizes redirects and strips cross-origin credentials", async () => {
    const authorizedUrls: string[] = []
    const authorize: McpRemoteRequestAuthorizer = vi.fn(async ({ url }) => {
      authorizedUrls.push(url)
      return authorization(url)
    })
    const requests: McpRemoteFetchHopRequest[] = []
    const replies = [
      new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example/final" },
      }),
      new Response("done", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    ]
    const hop: McpRemoteFetchHop = vi.fn(async (request) => {
      requests.push(request)
      return replies.shift()!
    })
    const fetch = createMcpAuthorizedFetch(authorize, { hop })

    const response = await fetch("https://origin.example/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "X-API-Key": "secret",
        "Content-Type": "application/json",
        "X-Safe": "keep",
      },
      body: JSON.stringify({ hello: "world" }),
    })

    await expect(response.text()).resolves.toBe("done")
    expect(response.url).toBe("https://cdn.example/final")
    expect(authorizedUrls).toEqual([
      "https://origin.example/start",
      "https://cdn.example/final",
    ])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: "https://origin.example/start",
      method: "POST",
    })
    expect(bodyText(requests[0]?.body)).toBe('{"hello":"world"}')
    expect(requests[1]).toMatchObject({
      url: "https://cdn.example/final",
      method: "GET",
    })
    expect(requests[1]?.body).toBeUndefined()
    expect(requests[1]?.headers).toMatchObject({ "x-safe": "keep" })
    expect(Object.keys(requests[1]?.headers ?? {})).not.toEqual(
      expect.arrayContaining([
        "authorization",
        "cookie",
        "x-api-key",
        "content-type",
        "content-length",
      ]),
    )
  })

  it.each([
    {
      label: "a private pinned address",
      result: authorization("https://example.com/mcp", [{
        address: "127.0.0.1",
        family: 4,
      }]),
    },
    {
      label: "a different authorized URL",
      result: authorization("https://other.example/mcp"),
    },
    {
      label: "a different authorized hostname",
      result: {
        ...authorization("https://example.com/mcp"),
        hostname: "other.example",
      },
    },
    {
      label: "an IP literal absent from the pinned addresses",
      requestUrl: "https://93.184.216.34/mcp",
      result: authorization("https://93.184.216.34/mcp", [{
        address: "1.1.1.1",
        family: 4,
      }]),
    },
  ])("rejects $label before opening a network hop", async ({
    result,
    requestUrl = "https://example.com/mcp",
  }) => {
    const authorize: McpRemoteRequestAuthorizer = async () => result
    const hop = vi.fn<McpRemoteFetchHop>(async () => new Response("unsafe"))
    const fetch = createMcpAuthorizedFetch(authorize, { hop })

    await expect(fetch(requestUrl)).rejects.toThrow(
      /authorization|public|hostname|url/i,
    )
    expect(hop).not.toHaveBeenCalled()
  })

  it.each([
    ["a non-HTTP URL", "file:///tmp/mcp.sock", {}],
    ["URL credentials", "https://token@example.com/mcp", {}],
    ["an unsafe method", "https://example.com/mcp", { method: "CONNECT" }],
  ])("rejects %s before authorization", async (_label, url, init) => {
    const authorize = vi.fn<McpRemoteRequestAuthorizer>(async ({ url: target }) =>
      authorization(target)
    )
    const hop = vi.fn<McpRemoteFetchHop>(async () => new Response("unsafe"))
    const fetch = createMcpAuthorizedFetch(authorize, { hop })

    await expect(fetch(url, init)).rejects.toThrow(/http|credential|method/i)
    expect(authorize).not.toHaveBeenCalled()
    expect(hop).not.toHaveBeenCalled()
  })

  it("bounds request bodies and headers before authorization", async () => {
    const authorize = vi.fn<McpRemoteRequestAuthorizer>(async ({ url }) =>
      authorization(url)
    )
    const hop = vi.fn<McpRemoteFetchHop>(async () => new Response("unsafe"))
    const fetch = createMcpAuthorizedFetch(authorize, {
      hop,
      maxRequestBytes: 4,
      maxRequestHeaderBytes: 32,
    })

    await expect(fetch("https://example.com/mcp", {
      method: "POST",
      body: "12345",
    })).rejects.toThrow(/body|bytes|large/i)
    await expect(fetch("https://example.com/mcp", {
      headers: { "X-Oversized": "x".repeat(40) },
    })).rejects.toThrow(/header|bytes|large/i)
    expect(authorize).not.toHaveBeenCalled()
    expect(hop).not.toHaveBeenCalled()
  })

  it("encodes URLSearchParams and preserves request bodies across 307 redirects", async () => {
    const requests: McpRemoteFetchHopRequest[] = []
    const authorize: McpRemoteRequestAuthorizer = async ({ url }) =>
      authorization(url)
    const hop: McpRemoteFetchHop = async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: "/next" },
        })
      }
      return new Response("ok")
    }
    const fetch = createMcpAuthorizedFetch(authorize, { hop })

    await fetch("https://example.com/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token" }),
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.method).toBe("POST")
    expect(bodyText(requests[1]?.body)).toBe("grant_type=refresh_token")
    expect(requests[1]?.headers["content-type"]).toMatch(
      /^application\/x-www-form-urlencoded/u,
    )
    expect(requests[1]?.headers["content-length"]).toBe(
      String("grant_type=refresh_token".length),
    )
  })

  it("aborts while waiting for host authorization without opening a hop", async () => {
    const controller = new AbortController()
    const authorize = vi.fn<McpRemoteRequestAuthorizer>(
      () => new Promise(() => undefined),
    )
    const hop = vi.fn<McpRemoteFetchHop>(async () => new Response("unsafe"))
    const fetch = createMcpAuthorizedFetch(authorize, { hop })
    const pending = fetch("https://example.com/mcp", {
      signal: controller.signal,
    })

    controller.abort(new Error("cancelled"))

    await expect(pending).rejects.toThrow("cancelled")
    expect(hop).not.toHaveBeenCalled()
  })

  it("returns a streaming response and propagates abort after headers", async () => {
    const controller = new AbortController()
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        streamController = value
        value.enqueue(new TextEncoder().encode("first"))
      },
    })
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        hop: async () => new Response(stream),
      },
    )

    const response = await fetch("https://example.com/sse", {
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode("first"),
    })

    controller.abort(new Error("stream cancelled"))

    await expect(reader.read()).rejects.toThrow("stream cancelled")
    expect(() => streamController?.enqueue(new Uint8Array([1]))).toThrow()
  })

  it("rejects an oversized declared finite response before reading its body", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response(body, {
            headers: {
              "content-length": "5",
              "content-type": "application/json",
            },
          }),
      },
    )

    await expect(fetch("https://example.com/mcp")).rejects.toThrow(
      /response body exceeds 4 bytes/i,
    )
    expect(cancelled).toBe(true)
  })

  it("bounds a chunked finite response while it is being consumed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"))
        controller.enqueue(new TextEncoder().encode("45"))
        controller.close()
      },
    })
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response(stream, {
            headers: { "content-type": "application/json" },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).rejects.toThrow(
      /response body exceeds 4 bytes/i,
    )
  })

  it("treats Content-Length as an early hint but still counts streamed bytes", async () => {
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response("12345", {
            headers: {
              "content-length": "4",
              "content-type": "application/json",
            },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).rejects.toThrow(
      /response body exceeds 4 bytes/i,
    )
  })

  it("accepts grammar-valid leading zeroes in Content-Length", async () => {
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response("1", {
            headers: {
              "content-length": "01",
              "content-type": "application/json",
            },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).resolves.toBe("1")
  })

  it("bounds each SSE event even when its record spans chunks", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 12"))
        controller.enqueue(new TextEncoder().encode("345\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxSseEventBytes: 10,
        hop: async () =>
          new Response(stream, {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).rejects.toThrow(
      /SSE event exceeds 10 bytes/i,
    )
    expect(cancelled).toBe(true)
  })

  it("errors the consumer promptly even if upstream cancellation hangs", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"))
      },
      cancel() {
        return new Promise<void>(() => undefined)
      },
    })
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response(stream, {
            headers: { "content-type": "application/json" },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    const outcome = await Promise.race([
      response.text().then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed out"), 50)
      }),
    ])
    expect(outcome).toMatch(/response body exceeds 4 bytes/i)
  })

  it("does not validate representation length for a bodyless response", async () => {
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response(null, {
            headers: { "content-length": "999" },
          }),
      },
    )

    await expect(fetch("https://example.com/mcp", {
      method: "HEAD",
    })).resolves.toBeInstanceOf(Response)
  })

  it("does not apply the finite response limit across separate SSE events", async () => {
    const payload = "data: 1\n\ndata: 2\r\n\r\ndata: 3\r\r"
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        maxSseEventBytes: 12,
        hop: async () =>
          new Response(payload, {
            headers: { "content-type": "text/event-stream" },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).resolves.toBe(payload)
  })

  it("applies the finite response limit to a non-success SSE-labelled response", async () => {
    const fetch = createMcpAuthorizedFetch(
      async ({ url }) => authorization(url),
      {
        maxResponseBytes: 4,
        hop: async () =>
          new Response("12345", {
            status: 500,
            headers: { "content-type": "text/event-stream" },
          }),
      },
    )

    const response = await fetch("https://example.com/mcp")
    await expect(response.text()).rejects.toThrow(
      /response body exceeds 4 bytes/i,
    )
  })

  it("pins lookup results to the exact authorized addresses and hostname", async () => {
    const lookup = createMcpPinnedLookup(authorization(
      "https://example.com/mcp",
      [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    ))

    const all = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup("example.com", { all: true }, (error, addresses) => {
          if (error) reject(error)
          else if (Array.isArray(addresses)) resolve(addresses)
          else reject(new Error("Expected every pinned lookup address"))
        })
      },
    )
    expect(all).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ])

    await expect(new Promise<void>((resolve, reject) => {
      lookup("other.example", {}, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })).rejects.toThrow(/hostname mismatch/i)
  })

  it("keeps the original TLS hostname while opening a fresh pinned streaming hop", async () => {
    let requestOptions: RequestOptions | undefined
    const incomingStream = new PassThrough()
    const incoming = incomingStream as unknown as IncomingMessage
    incoming.statusCode = 200
    incoming.statusMessage = "OK"
    incoming.headers = { "content-type": "text/event-stream" }
    incoming.rawHeaders = ["Content-Type", "text/event-stream"]
    const outgoing = new EventEmitter() as ClientRequest
    outgoing.write = vi.fn(() => true)
    outgoing.end = vi.fn()
    const requestFactory: McpNodeRequestFactory = (options, onResponse) => {
      requestOptions = options
      queueMicrotask(() => {
        onResponse(incoming)
        incomingStream.write("data: first\n\n")
      })
      return outgoing
    }
    const target = "https://example.com:8443/mcp?session=1"
    const networkAuthorization = authorization(target)
    const hop = createNodePinnedMcpFetchHop({
      httpsRequest: requestFactory,
    })

    const response = await hop({
      url: target,
      authorization: networkAuthorization,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
      },
      body: new TextEncoder().encode("{}"),
      signal: new AbortController().signal,
    })

    expect(requestOptions).toMatchObject({
      protocol: "https:",
      hostname: "example.com",
      port: "8443",
      path: "/mcp?session=1",
      method: "POST",
      agent: false,
      maxHeaderSize: 64 * 1024,
    })
    expect(outgoing.maxHeadersCount).toBe(256)
    expect(requestOptions?.lookup).toBeTypeOf("function")
    const address = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        requestOptions!.lookup!("example.com", { family: 4 }, (
          error,
          pinnedAddress,
          family,
        ) => {
          if (error) reject(error)
          else if (
            typeof pinnedAddress === "string" &&
            typeof family === "number"
          ) {
            resolve({ address: pinnedAddress, family })
          } else {
            reject(new Error("Expected one pinned address"))
          }
        })
      },
    )
    expect(address).toEqual(PUBLIC_V4)
    expect(outgoing.write).toHaveBeenCalledWith(
      new TextEncoder().encode("{}"),
    )
    expect(outgoing.end).toHaveBeenCalledOnce()

    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode("data: first\n\n"),
    })
    incomingStream.end()
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })
})
