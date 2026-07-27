import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type {
  HostNetworkRequest,
  ToolContext,
} from "../../types.js"
import { createNexusRunServices } from "../../agent/run-services.js"
import { executeToolPipeline } from "../../agent/tool-pipeline.js"

const { requestNetworkResourceMock } = vi.hoisted(() => ({
  requestNetworkResourceMock: vi.fn(),
}))

vi.mock("../../network/network-request.js", () => ({
  requestNetworkResource: requestNetworkResourceMock,
}))

import { webFetchTool, webSearchTool } from "./web-fetch.js"

function networkResponse(
  body: string,
  options: {
    status?: number
    statusText?: string
    contentType?: string
    url?: string
  } = {},
) {
  return {
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: {
      "content-type": options.contentType ?? "text/plain",
    },
    body: new TextEncoder().encode(body),
    url: options.url ?? "https://example.com/",
    redirectCount: 0,
  }
}

function createContext(authorizations: HostNetworkRequest[]): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    host: createFakeHost({
      cwd,
      async authorizeNetworkRequest(request) {
        authorizations.push(request)
        return {
          url: new URL(request.url).toString(),
          hostname: new URL(request.url).hostname,
          addresses: [{ address: "93.184.216.34", family: 4 }],
        }
      },
    }),
    session: createFakeSession(cwd),
    config: createTestConfig(),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
}

describe("model-facing web tools use the host network capability", () => {
  beforeEach(() => {
    requestNetworkResourceMock.mockReset()
    vi.stubEnv("FIRECRAWL_API_KEY", "")
    vi.stubEnv("FIRECRAWL_API_URL", "")
    vi.stubEnv("BRAVE_API_KEY", "")
    vi.stubEnv("SERPER_API_KEY", "")
    vi.stubEnv("NEXUS_SKIP_FIRECRAWL", "1")
    vi.stubEnv("NEXUS_WEB_SEARCH_MODE", "")
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("global fetch must not be used by model-facing web tools")
    }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("uses the bounded secure requester for a direct WebFetch target", async () => {
    const authorizations: HostNetworkRequest[] = []
    requestNetworkResourceMock.mockResolvedValue(networkResponse(
      "<h1>Safe docs</h1>",
      {
        contentType: "text/html; charset=utf-8",
        url: "https://example.com/docs",
      },
    ))
    const context = createContext(authorizations)

    const result = await webFetchTool.execute(
      { url: "https://example.com/docs" },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("# Safe docs")
    expect(authorizations).toEqual([])
    expect(requestNetworkResourceMock).toHaveBeenCalledWith(
      context.host,
      "https://example.com/docs",
      expect.objectContaining({
        purpose: "web_fetch",
        maxRedirects: 5,
        maxResponseBytes: 5 * 1024 * 1024,
        timeoutMs: 30_000,
        signal: context.signal,
      }),
    )
  })

  it("preauthorizes the target before sending it to Firecrawl", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-secret")
    vi.stubEnv("NEXUS_SKIP_FIRECRAWL", "0")
    const authorizations: HostNetworkRequest[] = []
    requestNetworkResourceMock.mockResolvedValue(networkResponse(
      JSON.stringify({
        success: true,
        data: { markdown: "# Firecrawl docs" },
      }),
      {
        contentType: "application/json",
        url: "https://api.firecrawl.dev/v1/scrape",
      },
    ))
    const context = createContext(authorizations)

    const result = await webFetchTool.execute(
      { url: "https://example.com/js-app" },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("# Firecrawl docs")
    expect(authorizations[0]).toEqual({
      url: "https://example.com/js-app",
      purpose: "web_fetch",
    })
    expect(requestNetworkResourceMock).toHaveBeenCalledWith(
      context.host,
      "https://api.firecrawl.dev/v1/scrape",
      expect.objectContaining({
        purpose: "web_fetch",
        method: "POST",
        signal: context.signal,
      }),
    )
  })

  it("does not send a denied target URL to Firecrawl", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-secret")
    vi.stubEnv("NEXUS_SKIP_FIRECRAWL", "0")
    const cwd = process.cwd()
    const context: ToolContext = {
      cwd,
      host: createFakeHost({
        cwd,
        async authorizeNetworkRequest() {
          throw Object.assign(new Error("private target"), {
            name: "NetworkPolicyError",
            code: "blocked_address",
          })
        },
      }),
      session: createFakeSession(cwd),
      config: createTestConfig(),
      services: createNexusRunServices(),
      mode: "agent",
      signal: new AbortController().signal,
    }

    const result = await webFetchTool.execute(
      { url: "https://private.example/internal" },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain("Blocked WebFetch target")
    expect(requestNetworkResourceMock).not.toHaveBeenCalled()
  })

  it("routes fixed WebSearch provider endpoints through the same requester", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-secret")
    const authorizations: HostNetworkRequest[] = []
    requestNetworkResourceMock.mockResolvedValue(networkResponse(
      JSON.stringify({
        web: {
          results: [{
            title: "Nexus docs",
            url: "https://docs.example/nexus",
            description: "The result",
          }],
        },
      }),
      {
        contentType: "application/json",
        url: "https://api.search.brave.com/res/v1/web/search",
      },
    ))
    const context = createContext(authorizations)

    const result = await webSearchTool.execute(
      { query: "nexus browser approval sentinel", max_results: 3 },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("Nexus docs")
    expect(requestNetworkResourceMock).toHaveBeenCalledTimes(1)
    expect(requestNetworkResourceMock).toHaveBeenCalledWith(
      context.host,
      expect.stringMatching(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/u),
      expect.objectContaining({
        purpose: "web_search",
        maxResponseBytes: 2 * 1024 * 1024,
        timeoutMs: 20_000,
        signal: context.signal,
      }),
    )
    expect(authorizations).toEqual([])
  })

  it("uses the secure requester for the free DuckDuckGo fallback", async () => {
    const authorizations: HostNetworkRequest[] = []
    requestNetworkResourceMock.mockResolvedValue(networkResponse(
      '<a class="result__a" href="https://example.com/result">Example result</a>',
      {
        contentType: "text/html",
        url: "https://html.duckduckgo.com/html/",
      },
    ))
    const context = createContext(authorizations)

    const result = await webSearchTool.execute(
      { query: "safe query", max_results: 2 },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("Example result")
    expect(requestNetworkResourceMock).toHaveBeenCalledWith(
      context.host,
      expect.stringContaining("https://html.duckduckgo.com/html/?"),
      expect.objectContaining({
        purpose: "web_search",
        signal: context.signal,
      }),
    )
    expect(authorizations).toEqual([])
  })

  it("does not send a search query before browser approval", async () => {
    const context = createContext([])
    context.config.permissions.autoApproveRead = true
    context.config.permissions.autoApproveBrowser = false

    const result = await executeToolPipeline(
      {
        callId: "web-search-denied",
        messageId: "message",
        partId: "part_web-search-denied",
        toolName: "WebSearch",
        input: { query: "must never leave the process" },
        origin: "native",
      },
      {
        tools: [webSearchTool],
        context,
        autoApproveActions: new Set(["read"]),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result).toMatchObject({
      success: false,
      denied: true,
    })
    expect(requestNetworkResourceMock).not.toHaveBeenCalled()
  })
})
