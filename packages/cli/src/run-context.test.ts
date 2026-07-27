import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  NexusConfigSchema,
  createNexusRunServices,
  type NexusConfig,
  type ToolContributionSnapshot,
  type ToolDef,
} from "@nexuscode/core"

import {
  createCliMcpRemoteRequestAuthorizer,
  createCliRunContext,
} from "./run-context.js"

function tool(name: string, serverName?: string): ToolDef {
  return {
    name,
    description: name,
    parameters: z.object({}),
    ...(serverName
      ? {
          integration: {
            kind: "mcp" as const,
            serverName,
            originalName: name,
          },
        }
      : {}),
    async execute() {
      return { success: true, output: name }
    },
  }
}

describe("CLI immutable run context", () => {
  it("uses the host network capability with the dedicated MCP purpose", async () => {
    const authorizeNetworkRequest = vi.fn(async () => ({
      url: "https://mcp.example/rpc",
      hostname: "mcp.example",
      addresses: [{ address: "93.184.216.34", family: 4 as const }],
    }))

    await createCliMcpRemoteRequestAuthorizer({
      authorizeNetworkRequest,
    })({
      url: "https://mcp.example/rpc",
      signal: new AbortController().signal,
    })

    expect(authorizeNetworkRequest).toHaveBeenCalledWith({
      url: "https://mcp.example/rpc",
      purpose: "mcp",
    })
  })

  it("pins custom/plugin bytes and exposes only allowed MCP servers", async () => {
    const customTool = tool("WorkspaceCustom")
    const contribution = Object.freeze({
      generation: "generation",
      fingerprint: "fingerprint",
      tools: Object.freeze([customTool]),
      diagnostics: Object.freeze([]),
    }) satisfies ToolContributionSnapshot
    const materialize = vi.fn(async () => contribution)
    const mcpClient = {
      getTools: () => [
        tool("docs__read", "docs"),
        tool("other__secret", "other"),
      ],
      listResources: vi.fn(async () => []),
      listResourceTemplates: vi.fn(async () => []),
      readResource: vi.fn(async () => []),
    }
    const services = createNexusRunServices({
      mcpClient: mcpClient as never,
      toolContributionManager: {
        materialize,
        close: vi.fn(async () => {}),
      } as never,
    })
    const authorityConfig = NexusConfigSchema.parse({
      tools: { custom: ["./trusted-tools"] },
    }) as NexusConfig
    const runtimeConfig = NexusConfigSchema.parse({
      ...authorityConfig,
      model: {
        ...authorityConfig.model,
        apiKey: "runtime-secret",
      },
    }) as NexusConfig

    const run = await createCliRunContext({
      cwd: "/workspace",
      authorityConfig,
      runtimeConfig,
      services,
      allowedMcpServerNames: new Set(["docs"]),
      remote: false,
    })

    expect(materialize).toHaveBeenCalledWith("/workspace", authorityConfig)
    expect(materialize).not.toHaveBeenCalledWith("/workspace", runtimeConfig)
    const names = run.toolRegistry.getAll().map((entry) => entry.name)
    expect(names).toContain("WorkspaceCustom")
    expect(names).toContain("docs__read")
    expect(names).toContainEqual(expect.stringMatching(
      /^McpListResources_docs_/u,
    ))
    expect(names).not.toContain("other__secret")
    expect(run.services.toolContributionSnapshot).toBe(contribution)
    expect(run.services.mcpToolSnapshot?.map((entry) => entry.name))
      .not.toContain("other__secret")
  })

  it("does not materialize local executable integrations for a remote run", async () => {
    const materialize = vi.fn()
    const services = createNexusRunServices({
      toolContributionManager: {
        materialize,
        close: vi.fn(async () => {}),
      } as never,
    })
    const config = NexusConfigSchema.parse({}) as NexusConfig

    const run = await createCliRunContext({
      cwd: "/workspace",
      authorityConfig: config,
      runtimeConfig: config,
      services,
      allowedMcpServerNames: new Set(["local-only"]),
      remote: true,
    })

    expect(materialize).not.toHaveBeenCalled()
    expect(run.services.mcpToolSnapshot).toEqual([])
  })
})
