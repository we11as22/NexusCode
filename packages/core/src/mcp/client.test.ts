import { describe, expect, it, vi } from "vitest"
import { McpClient, buildMcpToolSchema } from "./client.js"

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
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "page-2" })
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
      clientFactory: () => toolClient as never,
      transportFactory: () => ({}) as never,
    })
    await calls.connect({ name: "tools", command: "tools" })
    const tool = calls.getTools()[0]!
    const result = await tool.execute({}, {} as never)
    expect(result).toMatchObject({ success: false })
    expect(result.output).toContain("timed out")
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
        throw new Error("401 Unauthorized")
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
      auth: { type: "oauth", startUrl: "https://example.test/login" },
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
