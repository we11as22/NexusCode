import { describe, expect, it } from "vitest"

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpServerConfigSchema } from "../config/schema.js"
import { createMcpTransport } from "./transport-factory.js"

describe("MCP remote endpoint validation", () => {
  it.each([
    "file:///tmp/mcp.sock",
    "vscode://extension/mcp",
    "https://token@example.test/mcp",
  ])("rejects an unsafe remote transport URL: %s", (url) => {
    expect(() => createMcpTransport({
      name: "unsafe",
      url,
      transport: "http",
    })).toThrow(/http|credentials/i)
    expect(McpServerConfigSchema.safeParse({
      name: "unsafe",
      url,
      transport: "http",
    }).success).toBe(false)
  })

  it("rejects conflicting transport aliases", () => {
    expect(McpServerConfigSchema.safeParse({
      name: "ambiguous",
      url: "https://example.test/mcp",
      transport: "http",
      type: "sse",
    }).success).toBe(false)
  })

  it("fails closed for a remote transport without an injected network authorizer", () => {
    expect(() => createMcpTransport({
      name: "remote",
      url: "https://example.test/mcp",
      transport: "http",
    })).toThrow(/network authorizer/i)
  })

  it("does not require a network authorizer for stdio transports", () => {
    expect(() => createMcpTransport({
      name: "local",
      command: "local-mcp",
      args: ["--stdio"],
    })).not.toThrow()
  })

  it.each(["http", "sse"] as const)(
    "injects the authorized fetch adapter into %s transports",
    (transport) => {
      const instance = createMcpTransport({
        name: "remote",
        url: "https://example.test/mcp",
        transport,
      }, {
        remoteRequestAuthorizer: async ({ url }) => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: "93.184.216.34", family: 4 }],
        }),
      })

      expect(
        (instance as unknown as { _fetch?: FetchLike })._fetch,
      ).toBeTypeOf("function")
    },
  )
})
