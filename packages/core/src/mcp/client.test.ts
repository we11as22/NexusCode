import { describe, expect, it, vi } from "vitest"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  McpClient,
  buildMcpToolSchema,
  renderMcpPromptResult,
} from "./client.js"

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [], isError: false })),
    listResources: vi.fn(async () => ({ resources: [] })),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    setNotificationHandler: vi.fn(),
    ...overrides,
  }
}

describe("McpClient lifecycle", () => {
  it("fails closed before a custom transport can bypass remote authorization", async () => {
    const client = fakeClient()
    const transportFactory = vi.fn(() => ({}) as never)
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory,
    })

    const status = await mcp.connect({
      name: "remote",
      url: "https://example.test/mcp",
      transport: "http",
    })

    expect(status.state).toBe("failed")
    expect(status.error).toMatch(/network authorizer/i)
    expect(transportFactory).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
  })

  it("additively ensures workspace servers without restarting live peers", async () => {
    const alpha = fakeClient()
    const beta = fakeClient()
    const clients = [alpha, beta]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.ensureConnected([
      { name: "alpha", command: "alpha" },
    ])
    await mcp.ensureConnected([
      { name: "alpha", command: "alpha" },
      { name: "beta", command: "beta" },
    ])
    await mcp.ensureConnected([
      { name: "alpha", command: "alpha" },
    ])

    expect(alpha.connect).toHaveBeenCalledOnce()
    expect(beta.connect).toHaveBeenCalledOnce()
    expect(alpha.close).not.toHaveBeenCalled()
    expect(beta.close).not.toHaveBeenCalled()
    expect(mcp.getServerStatuses()).toMatchObject({
      alpha: { state: "connected" },
      beta: { state: "connected" },
    })
  })

  it("invalidates a connect before its first asynchronous startup step", async () => {
    const client = fakeClient()
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    const connecting = mcp.connect({ name: "demo", command: "demo" })
    await mcp.disconnectAll()
    await connecting

    expect(client.connect).not.toHaveBeenCalled()
    expect(mcp.getTools()).toEqual([])
    expect(mcp.getServerStatuses().demo).toBeUndefined()
  })

  it("keeps the newest connection when an older startup completes late", async () => {
    let releaseFirst: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let unblockFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve
    })
    const first = fakeClient({
      connect: vi.fn(async () => {
        releaseFirst?.()
        await firstBlocked
      }),
      listTools: vi.fn(async () => ({
        tools: [{
          name: "stale",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const second = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "current",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const clients = [first, second]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })

    const staleConnect = mcp.connect({ name: "demo", command: "old" })
    await firstStarted
    await mcp.connect({ name: "demo", command: "new" })
    unblockFirst?.()
    await staleConnect

    expect(mcp.getTools().map((tool) => tool.name)).toEqual(["demo__current"])
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })

  it("does not resurrect an in-flight startup after disconnectAll", async () => {
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = fakeClient({
      connect: vi.fn(async () => {
        signalStarted?.()
        await blocked
      }),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    const connecting = mcp.connect({ name: "demo", command: "demo" })
    await started
    await mcp.disconnectAll()
    release?.()
    await connecting

    expect(mcp.getTools()).toEqual([])
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("connectAll removes a server even while that server is still starting", async () => {
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = fakeClient({
      connect: vi.fn(async () => {
        signalStarted?.()
        await blocked
      }),
      listTools: vi.fn(async () => ({
        tools: [{
          name: "zombie",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    const connecting = mcp.connect({ name: "demo", command: "demo" })
    await started
    await mcp.connectAll([])
    release?.()
    await connecting

    expect(mcp.getTools()).toEqual([])
    expect(mcp.getServerStatuses().demo).toBeUndefined()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("reports failures, closes failed transports, and removes stale tools on reconnect", async () => {
    const first = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "old",
          description: "old tool",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const second = fakeClient({
      connect: vi.fn(async () => {
        throw new Error("connection refused")
      }),
    })
    const clients = [first, second]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "demo", command: "demo" })
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(["demo__old"])

    await mcp.connect({ name: "demo", command: "demo" })
    expect(mcp.getTools()).toEqual([])
    expect(mcp.getServerStatuses().demo).toMatchObject({
      state: "failed",
      error: "connection refused",
      toolCount: 0,
    })
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it("paginates tools, tracks annotations, and refreshes on list-changed notifications", async () => {
    let notification: (() => Promise<void>) | undefined
    const listTools = vi.fn()
      .mockResolvedValueOnce({
        tools: [{
          name: "read",
          description: "x".repeat(3000),
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { tags: { type: "array", items: { type: "string" } } },
            required: ["tags"],
          },
        }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        tools: [{
          name: "write",
          annotations: { destructiveHint: true },
          inputSchema: { type: "object", properties: {} },
        }],
      })
      .mockResolvedValueOnce({
        tools: [{
          name: "replacement",
          inputSchema: { type: "object", properties: {} },
        }],
      })
    const client = fakeClient({
      listTools,
      setNotificationHandler: vi.fn((_schema, handler) => {
        notification = handler
      }),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "demo", command: "demo" })
    const tools = mcp.getTools()
    expect(listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: "page-2" },
      { signal: expect.any(AbortSignal) },
    )
    expect(tools.map((tool) => tool.name)).toEqual(["demo__read", "demo__write"])
    expect(tools[0]?.readOnly).toBe(true)
    expect(tools[0]?.description.length).toBeLessThanOrEqual(2100)
    expect(tools[0]?.integration).toEqual({
      kind: "mcp",
      serverName: "demo",
      originalName: "read",
    })
    expect(tools[0]?.parameters.safeParse({ tags: ["a", "b"] }).success).toBe(true)
    expect(tools[0]?.parameters.safeParse({ tags: [{ nope: true }] }).success).toBe(false)

    await notification?.()
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(["demo__replacement"])
  })

  it("keeps raw MCP identity separate from provider-safe callable names", async () => {
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "review/pr",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "review_pr",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      })),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "team-calendar", command: "demo" })
    const tools = mcp.getTools()

    expect(tools).toHaveLength(2)
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(2)
    expect(tools.every((tool) =>
      /^[A-Za-z0-9_]{1,64}$/u.test(tool.name)
    )).toBe(true)
    const originalName = (tool: (typeof tools)[number]) =>
      tool.integration?.kind === "mcp"
        ? tool.integration.originalName
        : undefined
    expect(tools.map(originalName).sort()).toEqual([
      "review/pr",
      "review_pr",
    ])

    await tools.find(
      (tool) => originalName(tool) === "review/pr",
    )!.execute({}, {} as never)
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "review/pr", arguments: {} },
      undefined,
      { signal: expect.any(AbortSignal) },
    )
  })

  it("shares a bounded prompt catalog and validates prompt arguments", async () => {
    let promptNotification: (() => Promise<void>) | undefined
    const listPrompts = vi.fn()
      .mockResolvedValueOnce({
        prompts: [{
          name: "review",
          description: "Review a target",
          arguments: [
            { name: "target", required: true },
            { name: "focus", required: false },
          ],
        }],
      })
      .mockResolvedValueOnce({
        prompts: [{
          name: "replacement",
          arguments: [],
        }],
      })
    const getPrompt = vi.fn(async () => ({
      description: "Rendered review",
      messages: [
        {
          role: "user" as const,
          content: { type: "text", text: "Review src" },
        },
        {
          role: "assistant" as const,
          content: {
            type: "resource_link",
            uri: "file:///workspace/src",
            name: "src",
          },
        },
      ],
    }))
    const client = fakeClient({
      getServerCapabilities: vi.fn(() => ({
        prompts: { listChanged: true },
      })),
      listPrompts,
      getPrompt,
      setNotificationHandler: vi.fn((schema, handler) => {
        if (schema === PromptListChangedNotificationSchema) {
          promptNotification = handler
        }
      }),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "catalog", command: "catalog" })
    expect(mcp.getPromptCatalog()).toEqual([
      {
        serverName: "catalog",
        name: "review",
        description: "Review a target",
        arguments: [
          { name: "target", required: true },
          { name: "focus", required: false },
        ],
      },
    ])
    await expect(
      mcp.getPrompt("catalog", "review", {}),
    ).rejects.toThrow(/required argument "target"/i)
    await expect(
      mcp.getPrompt("catalog", "review", {
        target: "src",
        surprise: "no",
      }),
    ).rejects.toThrow(/unknown argument "surprise"/i)

    const result = await mcp.getPrompt("catalog", "review", {
      target: "src",
    })
    expect(getPrompt).toHaveBeenCalledWith(
      {
        name: "review",
        arguments: { target: "src" },
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(renderMcpPromptResult(result)).toContain("Review src")
    expect(renderMcpPromptResult(result)).toContain(
      "MCP resource link: src",
    )

    await promptNotification?.()
    expect(mcp.getPromptCatalog().map((prompt) => prompt.name)).toEqual([
      "replacement",
    ])
  })

  it("rejects malformed prompt resources and disconnects the server", async () => {
    const client = fakeClient({
      getServerCapabilities: vi.fn(() => ({ prompts: {} })),
      listPrompts: vi.fn(async () => ({
        prompts: [{ name: "broken", arguments: [] }],
      })),
      getPrompt: vi.fn(async () => ({
        messages: [{
          role: "user" as const,
          content: {
            type: "resource",
            resource: { text: "missing uri" },
          },
        }],
      })),
    })
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "catalog", command: "catalog" })
    await expect(
      mcp.getPrompt("catalog", "broken", {}),
    ).rejects.toThrow(/non-empty URI/i)
    expect(mcp.getServerStatuses().catalog?.state).toBe("disconnected")
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("times out startup and tool calls without leaving a connected zombie", async () => {
    const startupClient = fakeClient({
      connect: vi.fn(() => new Promise<void>(() => {})),
    })
    const mcp = new McpClient({
      startupTimeoutMs: 5,
      toolTimeoutMs: 5,
      clientFactory: () => startupClient as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "slow", command: "slow" })
    expect(mcp.getServerStatuses().slow?.state).toBe("failed")
    expect(mcp.getServerStatuses().slow?.error).toContain("timed out")
    expect(startupClient.close).toHaveBeenCalledOnce()

    const toolClient = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "hang",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
      callTool: vi.fn(() => new Promise(() => {})),
    })
    const calls = new McpClient({
      toolTimeoutMs: 5,
      reconnectAttempts: 0,
      clientFactory: () => toolClient as never,
      transportFactory: () => ({}) as never,
    })
    await calls.connect({ name: "tools", command: "tools" })
    const tool = calls.getTools()[0]!
    const result = await tool.execute({}, {} as never)
    expect(result).toMatchObject({ success: false })
    expect(result.output).toContain("timed out")
    const requestOptions = (
      toolClient.callTool.mock.calls as unknown as Array<unknown[]>
    )[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined
    expect(requestOptions?.signal?.aborted).toBe(true)
    expect(toolClient.close).toHaveBeenCalledOnce()
    expect(calls.getServerStatuses().tools?.state).toBe("disconnected")
  })

  it("propagates the turn abort signal into an active MCP call", async () => {
    let requestSignal: AbortSignal | undefined
    const toolClient = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "hang",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
      callTool: vi.fn((
        _params: unknown,
        _resultSchema: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestSignal = options?.signal
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }),
    })
    const mcp = new McpClient({
      toolTimeoutMs: 1_000,
      reconnectAttempts: 0,
      clientFactory: () => toolClient as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "tools", command: "tools" })
    const controller = new AbortController()
    const pending = mcp.getTools()[0]!.execute(
      {},
      { signal: controller.signal } as never,
    )

    controller.abort(new Error("turn interrupted"))
    const result = await pending

    expect(requestSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ success: false })
    expect(result.output).toContain("cancelled")
    expect(toolClient.close).toHaveBeenCalledOnce()
  })

  it("cancels active requests before disconnecting a server", async () => {
    let requestSignal: AbortSignal | undefined
    const toolClient = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "hang",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
      callTool: vi.fn((
        _params: unknown,
        _resultSchema: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestSignal = options?.signal
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }),
    })
    const mcp = new McpClient({
      toolTimeoutMs: 1_000,
      reconnectAttempts: 0,
      clientFactory: () => toolClient as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "tools", command: "tools" })
    const pending = mcp.getTools()[0]!.execute({}, {} as never)

    await mcp.disconnectAll()
    const result = await pending

    expect(requestSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ success: false })
    expect(result.output).toContain("disconnected")
    expect(toolClient.close).toHaveBeenCalledOnce()
  })

  it("rejects maliciously deep tool schemas before exposing them", async () => {
    let schema: Record<string, unknown> = { type: "string" }
    for (let depth = 0; depth < 40; depth += 1) {
      schema = {
        type: "object",
        properties: { nested: schema },
      }
    }
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "deep",
          inputSchema: schema,
        }],
      })),
    })
    const mcp = new McpClient({
      reconnectAttempts: 0,
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })

    const status = await mcp.connect({ name: "hostile", command: "hostile" })

    expect(status.state).toBe("failed")
    expect(status.error).toContain("schema")
    expect(mcp.getTools()).toEqual([])
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("rejects oversized tool results instead of retaining raw payloads", async () => {
    const huge = "x".repeat(2_100_000)
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "huge",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: huge }],
        structuredContent: { duplicate: huge },
        isError: false,
      })),
    })
    const mcp = new McpClient({
      reconnectAttempts: 0,
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "bounded", command: "bounded" })

    const result = await mcp.getTools()[0]!.execute(
      {},
      { signal: new AbortController().signal } as never,
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain("exceeded")
    expect(result.output.length).toBeLessThan(1_000)
    expect(JSON.stringify(result.metadata ?? {})).not.toContain(huge.slice(0, 1_000))
  })

  it("propagates cancellation to resource reads and closes the transport", async () => {
    let requestSignal: AbortSignal | undefined
    const client = fakeClient({
      readResource: vi.fn((
        _params: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestSignal = options?.signal
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      }),
    })
    const mcp = new McpClient({
      toolTimeoutMs: 1_000,
      reconnectAttempts: 0,
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "resources", command: "resources" })
    const controller = new AbortController()
    const pending = mcp.readResource(
      "resources",
      "file:///demo",
      controller.signal,
    )

    controller.abort()

    await expect(pending).rejects.toThrow("cancelled")
    expect(requestSignal?.aborted).toBe(true)
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("rejects oversized resource listings instead of returning partial truth", async () => {
    const client = fakeClient({
      listResources: vi.fn(async () => ({
        resources: Array.from({ length: 2_049 }, (_value, index) => ({
          uri: `file:///${index}`,
          name: `resource-${index}`,
        })),
      })),
    })
    const mcp = new McpClient({
      reconnectAttempts: 0,
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "resources", command: "resources" })

    await expect(mcp.listResources("resources")).rejects.toThrow("exceeded")
    expect(mcp.getServerStatuses().resources?.state).toBe("disconnected")
  })

  it("marks expired authentication and reconnects after a successful host handoff", async () => {
    const expired = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "private",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
      callTool: vi.fn(async () => {
        throw new UnauthorizedError("Authentication required")
      }),
    })
    const recovered = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "private",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const clients = [expired, recovered]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({
      name: "secure",
      command: "secure",
      auth: { type: "url", startUrl: "https://example.test/login" },
    })
    await mcp.getTools()[0]!.execute({}, {} as never)
    expect(mcp.getServerStatuses().secure?.state).toBe("needs_auth")

    const result = await mcp.authenticate("secure", {
      requestMcpAuthentication: vi.fn(async () => ({
        success: true,
        message: "Authenticated",
      })),
    } as never)
    expect(result.success).toBe(true)
    expect(mcp.getServerStatuses().secure?.state).toBe("connected")
    expect(expired.close).toHaveBeenCalledOnce()
  })

  it("does not treat opening an authentication URL as completed login", async () => {
    const initial = fakeClient()
    const shouldNotReconnect = fakeClient()
    const clients = [initial, shouldNotReconnect]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({
      name: "secure",
      command: "secure",
      auth: { type: "url", startUrl: "https://example.test/login" },
    })

    const result = await mcp.authenticate("secure", {
      requestMcpAuthentication: vi.fn(async () => ({
        success: false,
        pending: true,
        message: "Authentication page opened; finish login and retry.",
      })),
    } as never)

    expect(result).toMatchObject({ success: false, pending: true })
    expect(shouldNotReconnect.connect).not.toHaveBeenCalled()
  })

  it.each([
    "file:///tmp/steal-token",
    "vscode://malicious-extension/login",
    "https://token@example.test/login",
  ])("rejects an unsafe authentication handoff URL before invoking the host: %s", async (startUrl) => {
    const client = fakeClient()
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({
      name: "secure",
      command: "secure",
      auth: { type: "url", startUrl },
    })
    const requestMcpAuthentication = vi.fn()

    const result = await mcp.authenticate("secure", {
      requestMcpAuthentication,
    } as never)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/http|credentials/i)
    expect(requestMcpAuthentication).not.toHaveBeenCalled()
  })

  it("fails honestly for OAuth until a workspace coordinator completes the exchange", async () => {
    const client = fakeClient()
    const mcp = new McpClient({
      clientFactory: () => client as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({
      name: "oauth",
      url: "https://example.test/mcp",
      auth: {
        type: "oauth",
        startUrl: "https://example.test/authorize",
      },
    })
    const requestMcpAuthentication = vi.fn()

    const result = await mcp.authenticate("oauth", {
      requestMcpAuthentication,
    } as never)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/not available|coordinator/i)
    expect(requestMcpAuthentication).not.toHaveBeenCalled()
  })

  it("does not let a late list-changed refresh overwrite a newer connection", async () => {
    let notification: (() => Promise<void>) | undefined
    let releaseOldRefresh: ((value: unknown) => void) | undefined
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = resolve
    })
    const first = fakeClient({
      listTools: vi.fn()
        .mockResolvedValueOnce({
          tools: [{
            name: "initial",
            inputSchema: { type: "object", properties: {} },
          }],
        })
        .mockImplementationOnce(() => oldRefresh),
      setNotificationHandler: vi.fn((_schema, handler) => {
        notification = handler
      }),
    })
    const second = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "current",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const clients = [first, second]
    const mcp = new McpClient({
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })
    await mcp.connect({ name: "demo", command: "demo" })
    const late = notification?.()
    await Promise.resolve()
    await mcp.connect({ name: "demo", command: "demo" })
    releaseOldRefresh?.({
      tools: [{
        name: "stale",
        inputSchema: { type: "object", properties: {} },
      }],
    })
    await late
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(["demo__current"])
  })

  it("reconnects a dropped transport without replaying the interrupted tool call", async () => {
    vi.useFakeTimers()
    const first = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "mutate",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const second = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: "mutate",
          inputSchema: { type: "object", properties: {} },
        }],
      })),
    })
    const clients = [first, second]
    const mcp = new McpClient({
      reconnectAttempts: 2,
      reconnectBaseDelayMs: 10,
      clientFactory: () => clients.shift() as never,
      transportFactory: () => ({}) as never,
    })

    await mcp.connect({ name: "demo", command: "demo" })
    expect(typeof (first as { onclose?: unknown }).onclose).toBe("function")
    ;(first as { onclose?: () => void }).onclose?.()
    expect(mcp.getServerStatuses().demo?.state).toBe("disconnected")

    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => {
      expect(mcp.getServerStatuses().demo?.state).toBe("connected")
    })

    expect(first.callTool).not.toHaveBeenCalled()
    expect(second.connect).toHaveBeenCalledOnce()
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(["demo__mutate"])
    await mcp.disconnectAll()
    vi.useRealTimers()
  })
})

describe("buildMcpToolSchema", () => {
  it("preserves primitive array item schemas", () => {
    const schema = buildMcpToolSchema({
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" } },
        flags: { type: "array", items: { type: "boolean" } },
      },
      required: ["names"],
    })
    expect(schema.safeParse({ names: ["a"], flags: [true] }).success).toBe(true)
    expect(schema.safeParse({ names: [{ value: "a" }] }).success).toBe(false)
  })
})
