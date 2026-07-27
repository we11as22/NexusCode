import { describe, expect, it, vi } from "vitest"

import { createFakeHost } from "../test/fakes.js"
import type {
  AuthorizedNetworkRequest,
  HostNetworkRequest,
} from "../types.js"
import { authorizeNetworkRequest } from "./network-policy.js"
import {
  NetworkRequestError,
  requestNetworkResource,
  type NetworkTransport,
  type NetworkTransportResponse,
} from "./network-request.js"

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 as const }

function response(
  status: number,
  options: {
    statusText?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
  } = {},
): NetworkTransportResponse {
  const body =
    typeof options.body === "string"
      ? new TextEncoder().encode(options.body)
      : options.body ?? new Uint8Array()
  return {
    status,
    statusText: options.statusText ?? "",
    headers: options.headers ?? {},
    body,
  }
}

function publicAuthorizer(
  calls: HostNetworkRequest[],
): (request: HostNetworkRequest) => Promise<AuthorizedNetworkRequest> {
  return async (request) => {
    calls.push(request)
    return authorizeNetworkRequest(request, {
      resolve: async (hostname) => {
        if (hostname === "private.example") {
          return [{ address: "169.254.169.254", family: 4 }]
        }
        return [PUBLIC_V4]
      },
    })
  }
}

describe("secure network request transport", () => {
  it("preserves the dedicated MCP purpose through host authorization", async () => {
    const authorizations: HostNetworkRequest[] = []
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer(authorizations),
    })
    const transport = vi.fn<NetworkTransport>(async () =>
      response(200, { body: "{}" }),
    )

    await requestNetworkResource(host, "https://mcp.example/rpc", {
      purpose: "mcp",
      transport,
    })

    expect(authorizations).toEqual([{
      url: "https://mcp.example/rpc",
      purpose: "mcp",
    }])
  })

  it("supports the audited remote-session purpose without bypassing host authorization", async () => {
    const authorizations: HostNetworkRequest[] = []
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer(authorizations),
    })
    const transport = vi.fn<NetworkTransport>(async () =>
      response(200, { body: "{}" }),
    )

    await requestNetworkResource(host, "https://nexus.example/session/one", {
      purpose: "remote_session",
      transport,
    })

    expect(authorizations).toEqual([{
      url: "https://nexus.example/session/one",
      purpose: "remote_session",
    }])
    expect(transport).toHaveBeenCalledOnce()
  })

  it("reauthorizes and repins every redirect hop", async () => {
    const authorizations: HostNetworkRequest[] = []
    const transportCalls: Array<{
      url: string
      addresses: readonly { address: string; family: 4 | 6 }[]
    }> = []
    const replies = [
      response(302, { headers: { location: "/second" } }),
      response(307, { headers: { location: "https://cdn.example/final" } }),
      response(200, {
        headers: { "content-type": "text/plain" },
        body: "done",
      }),
    ]
    const transport: NetworkTransport = vi.fn(async (request) => {
      transportCalls.push({
        url: request.url,
        addresses: request.authorization.addresses,
      })
      return replies.shift()!
    })
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer(authorizations),
    })

    const result = await requestNetworkResource(
      host,
      "https://origin.example/start",
      {
        purpose: "web_fetch",
        transport,
      },
    )

    expect(new TextDecoder().decode(result.body)).toBe("done")
    expect(result.url).toBe("https://cdn.example/final")
    expect(authorizations.map((request) => request.url)).toEqual([
      "https://origin.example/start",
      "https://origin.example/second",
      "https://cdn.example/final",
    ])
    expect(transportCalls).toEqual([
      { url: "https://origin.example/start", addresses: [PUBLIC_V4] },
      { url: "https://origin.example/second", addresses: [PUBLIC_V4] },
      { url: "https://cdn.example/final", addresses: [PUBLIC_V4] },
    ])
  })

  it("blocks a redirect before the transport can connect to a private target", async () => {
    const authorizations: HostNetworkRequest[] = []
    const transport = vi.fn<NetworkTransport>(async () =>
      response(302, { headers: { location: "http://private.example/latest/meta-data" } }),
    )
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer(authorizations),
    })

    await expect(requestNetworkResource(
      host,
      "https://origin.example/start",
      {
        purpose: "web_fetch",
        transport,
      },
    )).rejects.toMatchObject({
      name: "NetworkPolicyError",
      code: "blocked_address",
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(authorizations.map((request) => request.url)).toEqual([
      "https://origin.example/start",
      "http://private.example/latest/meta-data",
    ])
  })

  it("fails closed when the host capability is unavailable or malformed", async () => {
    const transport = vi.fn<NetworkTransport>(async () => response(200))

    await expect(requestNetworkResource(
      createFakeHost(),
      "https://example.com/",
      { purpose: "web_fetch", transport },
    )).rejects.toThrow(/network authorization/i)

    await expect(requestNetworkResource(
      createFakeHost({
        async authorizeNetworkRequest(request) {
          return {
            url: request.url,
            hostname: "example.com",
            addresses: [{ address: "127.0.0.1", family: 4 }],
          }
        },
      }),
      "https://example.com/",
      { purpose: "web_fetch", transport },
    )).rejects.toThrow(/non-public/i)
    expect(transport).not.toHaveBeenCalled()
  })

  it("enforces redirect and response-size limits", async () => {
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer([]),
    })
    const redirectTransport: NetworkTransport = async () =>
      response(302, { headers: { location: "/again" } })

    await expect(requestNetworkResource(
      host,
      "https://example.com/start",
      {
        purpose: "web_fetch",
        maxRedirects: 1,
        transport: redirectTransport,
      },
    )).rejects.toMatchObject({
      code: "too_many_redirects",
    })

    await expect(requestNetworkResource(
      host,
      "https://example.com/large",
      {
        purpose: "web_fetch",
        maxResponseBytes: 4,
        transport: async () => response(200, { body: "12345" }),
      },
    )).rejects.toMatchObject({
      code: "response_too_large",
    })
  })

  it("uses one total deadline and propagates caller cancellation", async () => {
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer([]),
    })
    const waitForAbort: NetworkTransport = async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })

    await expect(requestNetworkResource(
      host,
      "https://example.com/slow",
      {
        purpose: "web_fetch",
        timeoutMs: 10,
        transport: waitForAbort,
      },
    )).rejects.toMatchObject({
      code: "timeout",
    })

    const controller = new AbortController()
    const pending = requestNetworkResource(
      host,
      "https://example.com/cancelled",
      {
        purpose: "web_fetch",
        timeoutMs: 30_000,
        signal: controller.signal,
        transport: waitForAbort,
      },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      code: "aborted",
    })
  })

  it("does not start authorization when already cancelled", async () => {
    const authorizeNetworkRequest = vi.fn(publicAuthorizer([]))
    const host = createFakeHost({ authorizeNetworkRequest })
    const controller = new AbortController()
    controller.abort()

    await expect(requestNetworkResource(
      host,
      "https://example.com/cancelled-before-start",
      {
        purpose: "web_fetch",
        signal: controller.signal,
        transport: async () => response(200),
      },
    )).rejects.toMatchObject({
      code: "aborted",
    })
    expect(authorizeNetworkRequest).not.toHaveBeenCalled()
  })

  it("applies browser redirect method semantics and strips cross-origin secrets", async () => {
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer([]),
    })
    const seen: Array<{
      url: string
      method: string
      headers: Readonly<Record<string, string>>
      body?: Uint8Array
    }> = []
    const transport: NetworkTransport = async (request) => {
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
      return seen.length === 1
        ? response(302, { headers: { location: "https://other.example/final" } })
        : response(200, { body: "ok" })
    }

    await requestNetworkResource(
      host,
      "https://api.example/search",
      {
        purpose: "web_search",
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=secret",
          "X-API-KEY": "secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: "safe" }),
        transport,
      },
    )

    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "https://api.example/search",
    })
    expect(seen[1]).toMatchObject({
      method: "GET",
      url: "https://other.example/final",
    })
    expect(seen[1]!.body).toBeUndefined()
    expect(Object.keys(seen[1]!.headers).map((key) => key.toLowerCase())).not.toEqual(
      expect.arrayContaining([
        "authorization",
        "cookie",
        "x-api-key",
        "content-type",
        "content-length",
      ]),
    )
  })

  it("rejects invalid redirect locations", async () => {
    const host = createFakeHost({
      authorizeNetworkRequest: publicAuthorizer([]),
    })

    for (const location of [
      "file:///etc/passwd",
      "https://user:password@example.com/",
      "http://[::1]/",
    ]) {
      await expect(requestNetworkResource(
        host,
        "https://example.com/start",
        {
          purpose: "web_fetch",
          transport: async () => response(302, { headers: { location } }),
        },
      )).rejects.toBeInstanceOf(Error)
    }
  })

  it("rejects invalid options before network authorization", async () => {
    const authorizeNetworkRequest = vi.fn(publicAuthorizer([]))
    const host = createFakeHost({ authorizeNetworkRequest })

    await expect(requestNetworkResource(
      host,
      "https://example.com/",
      {
        purpose: "web_fetch",
        maxResponseBytes: 0,
        transport: async () => response(200),
      },
    )).rejects.toBeInstanceOf(NetworkRequestError)
    expect(authorizeNetworkRequest).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "purpose",
      options: { purpose: "plugin_proxy" },
    },
    {
      label: "method",
      options: { purpose: "web_fetch", method: "CONNECT" },
    },
    {
      label: "header",
      options: {
        purpose: "web_fetch",
        headers: { "X-Test": "safe\r\nX-Injected: true" },
      },
    },
  ])("rejects an invalid $label before authorization", async ({ options }) => {
    const authorizeNetworkRequest = vi.fn(publicAuthorizer([]))
    const host = createFakeHost({ authorizeNetworkRequest })

    await expect(requestNetworkResource(
      host,
      "https://example.com/",
      {
        ...options,
        purpose: options.purpose as "web_fetch",
        transport: async () => response(200),
      },
    )).rejects.toMatchObject({
      code: "invalid_options",
    })
    expect(authorizeNetworkRequest).not.toHaveBeenCalled()
  })
})
