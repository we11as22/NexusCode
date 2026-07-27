import { describe, expect, it } from "vitest"
import {
  NexusConfigSchema,
  ToolRegistry,
  type AuthorizedNetworkRequest,
  type HostNetworkRequest,
  type NexusConfig,
  type NexusRunServices,
  type ToolContributionSnapshot,
  type ToolDef,
} from "@nexuscode/core"

import {
  createServerMcpRemoteRequestAuthorizer,
  prepareServerToolContributions,
  registerServerMcpCapabilities,
} from "./server-capabilities.js"

function dynamicTool(
  name: string,
  integration?: ToolDef["integration"],
): ToolDef {
  return {
    name,
    description: `${name} test tool`,
    parameters: {} as ToolDef["parameters"],
    ...(integration ? { integration } : {}),
    async execute() {
      return { success: true, output: "ok" }
    },
  }
}

describe("server MCP capability boundary", () => {
  it("authorizes every remote MCP hop through the host with the mcp purpose", async () => {
    const requests: HostNetworkRequest[] = []
    const authorization: AuthorizedNetworkRequest = {
      url: "https://mcp.example.test/rpc",
      hostname: "mcp.example.test",
      addresses: [{ address: "203.0.113.10", family: 4 }],
    }
    const authorize = createServerMcpRemoteRequestAuthorizer({
      async authorizeNetworkRequest(request) {
        requests.push(request)
        return authorization
      },
    })

    await expect(authorize({
      url: authorization.url,
      signal: new AbortController().signal,
    })).resolves.toBe(authorization)
    expect(requests).toEqual([{
      url: "https://mcp.example.test/rpc",
      purpose: "mcp",
    }])
  })

  it("registers direct and resource tools only for this turn's allowed MCP servers", () => {
    const registry = new ToolRegistry()
    const client = {
      getTools() {
        return [
          dynamicTool("docs_search", {
            kind: "mcp",
            serverName: "docs",
            originalName: "search",
          }),
          dynamicTool("stale_search", {
            kind: "mcp",
            serverName: "stale",
            originalName: "search",
          }),
        ]
      },
      async listResources() {
        return []
      },
      async listResourceTemplates() {
        return []
      },
      async readResource() {
        return []
      },
    }

    const snapshot = registerServerMcpCapabilities(
      registry,
      client,
      new Set(["docs"]),
    )

    expect(registry.get("docs_search")).toBeDefined()
    expect(registry.get("stale_search")).toBeUndefined()
    const resourceTools = registry.getAll().filter(
      (tool) =>
        tool.integration?.kind === "mcp" &&
        tool.integration.originalName.startsWith("resources/"),
    )
    expect(resourceTools).toHaveLength(3)
    expect(resourceTools.every(
      (tool) =>
        tool.integration?.kind === "mcp" &&
        tool.integration.serverName === "docs",
    )).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot).toEqual([
      registry.get("docs_search"),
      ...resourceTools,
    ])
  })
})

describe("server executable tool contribution boundary", () => {
  it("registers one immutable generation and passes it through run-local services", async () => {
    const workspaceTool = dynamicTool("TrustedWorkspaceTool", {
      kind: "custom",
      sourceId: "custom:/workspace/.nexus/tools",
      sourcePath: "/workspace/.nexus/tools",
      fingerprint: "source-fingerprint",
      bundleFingerprint: "bundle-fingerprint",
      generation: "generation-1",
    })
    const snapshot: ToolContributionSnapshot = Object.freeze({
      generation: "generation-1",
      fingerprint: "source-fingerprint",
      tools: Object.freeze([Object.freeze(workspaceTool)]),
      diagnostics: Object.freeze([Object.freeze({
        level: "warning" as const,
        code: "source-untrusted" as const,
        sourceId: "custom:/workspace/other-tools",
        sourcePath: "/workspace/other-tools",
        message: "Exact content has not been trusted.",
      })]),
    })
    const manager = {
      async materialize() {
        return snapshot
      },
    }
    const workspaceServices = {
      toolContributionManager: manager,
    } as unknown as NexusRunServices
    const registry = new ToolRegistry()
    const diagnostics: string[] = []
    const config = NexusConfigSchema.parse({}) as NexusConfig

    const runServices = await prepareServerToolContributions({
      cwd: "/workspace",
      config,
      services: workspaceServices,
      registry,
      onDiagnostic: (message) => diagnostics.push(message),
    })

    expect(registry.get("TrustedWorkspaceTool")).toBe(workspaceTool)
    expect(runServices).not.toBe(workspaceServices)
    expect(runServices.toolContributionManager).toBe(manager)
    expect(runServices.toolContributionSnapshot).toBe(snapshot)
    expect(Object.isFrozen(runServices.toolContributionSnapshot)).toBe(true)
    expect(diagnostics).toEqual([
      "[custom tool source-untrusted] /workspace/other-tools: Exact content has not been trusted.",
    ])
  })
})
