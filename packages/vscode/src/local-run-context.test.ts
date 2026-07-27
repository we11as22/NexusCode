import { describe, expect, it, vi } from "vitest"
import {
  NexusConfigSchema,
  ToolRegistry,
  createNexusRunServices,
  type NexusConfig,
  type ToolContributionSnapshot,
  type ToolDef,
} from "@nexuscode/core"

import {
  createVsCodeMcpRemoteRequestAuthorizer,
  prepareVsCodeRunIntegrations,
} from "./local-run-context.js"

function tool(name: string, serverName?: string): ToolDef {
  return {
    name,
    description: name,
    parameters: {} as ToolDef["parameters"],
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

describe("VS Code immutable local run context", () => {
  it("authorizes every remote MCP request through the host MCP capability", async () => {
    const authorizeNetworkRequest = vi.fn(async () => ({
      url: "https://mcp.example/rpc",
      hostname: "mcp.example",
      addresses: [{ address: "93.184.216.34", family: 4 as const }],
    }))

    await createVsCodeMcpRemoteRequestAuthorizer({
      authorizeNetworkRequest,
    })({
      url: "https://mcp.example/rpc",
      signal: new AbortController().signal,
    })

    expect(authorizeNetworkRequest).toHaveBeenCalledTimes(1)
    expect(authorizeNetworkRequest).toHaveBeenCalledWith({
      url: "https://mcp.example/rpc",
      purpose: "mcp",
    })
  })

  it("pins custom/plugin bytes and exposes only the selected MCP generation", async () => {
    const customTool = tool("WorkspaceCustom")
    const contribution = Object.freeze({
      generation: "generation",
      fingerprint: "fingerprint",
      tools: Object.freeze([Object.freeze(customTool)]),
      diagnostics: Object.freeze([
        Object.freeze({
          level: "warning" as const,
          code: "source-untrusted" as const,
          sourceId: "custom:/workspace/tools",
          sourcePath: "/workspace/tools",
          message: "Exact content is not trusted.",
        }),
      ]),
    }) satisfies ToolContributionSnapshot
    const materialize = vi.fn(async () => contribution)
    const mcpClient = {
      getTools: () => [
        tool("normalized_docs_read_8f61", "docs"),
        tool("normalized_other_secret_37ab", "other"),
        tool("NotMcp"),
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
      tools: { custom: ["./tools"] },
    }) as NexusConfig
    const registry = new ToolRegistry()

    const prepared = await prepareVsCodeRunIntegrations({
      cwd: "/workspace",
      authorityConfig,
      services,
      registry,
      allowedMcpServerNames: new Set(["docs"]),
    })

    expect(materialize).toHaveBeenCalledWith(
      "/workspace",
      authorityConfig,
    )
    const names = registry.getAll().map((entry) => entry.name)
    expect(names).toContain("WorkspaceCustom")
    expect(names).toContain("normalized_docs_read_8f61")
    expect(names).toContainEqual(expect.stringMatching(
      /^McpListResources_docs_/u,
    ))
    expect(names).not.toContain("normalized_other_secret_37ab")
    expect(names).not.toContain("NotMcp")
    expect(prepared.services.toolContributionSnapshot).toBe(contribution)
    expect(prepared.services.mcpToolSnapshot?.map((entry) => entry.name))
      .not.toContain("normalized_other_secret_37ab")
    expect(Object.isFrozen(prepared.services.mcpToolSnapshot)).toBe(true)
    expect(
      prepared.services.mcpToolSnapshot?.every((entry) =>
        Object.isFrozen(entry)
      ),
    ).toBe(true)
    expect(prepared.diagnostics).toBe(contribution.diagnostics)
  })
})
