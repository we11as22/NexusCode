import { describe, expect, it, vi } from "vitest"

import {
  ManagedWorkspaceRuntime,
  buildRemoteMcpPromptCatalog,
  type McpPromptRef,
  type NexusConfig,
} from "@nexuscode/core"

import {
  getServerMcpPromptCatalog,
  McpPromptCatalogConflictError,
  McpPromptNotFoundError,
  resolveServerMcpPrompt,
} from "./mcp-prompt-service.js"

const prompt: McpPromptRef = {
  serverName: "docs",
  name: "review",
  description: "Review documentation",
  arguments: [{ name: "target", required: true }],
}

function fixture() {
  const ensureConnected = vi.fn(async () => ({}))
  const getPromptCatalog = vi.fn(() => [prompt, {
    ...prompt,
    serverName: "stale-server",
    name: "hidden",
  }])
  const getPrompt = vi.fn(async () => ({
    serverName: "docs",
    name: "review",
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Review src",
      },
    }],
  }))
  const mcp = {
    ensureConnected,
    getPromptCatalog,
    getPrompt,
    async close() {},
  }
  const runtime = new ManagedWorkspaceRuntime("/workspace", {
    mcp,
  })
  const options = {
    loadConfig: vi.fn(async () => ({}) as NexusConfig),
    resolveServers: vi.fn(async () => ({
      servers: [{ name: "docs", command: "docs" }],
    })),
  }
  return {
    runtime,
    options,
    ensureConnected,
    getPrompt,
  }
}

describe("server MCP prompt service", () => {
  it("connects through the workspace runtime and exposes only configured servers", async () => {
    const { runtime, options, ensureConnected } = fixture()

    const catalog = await getServerMcpPromptCatalog(
      runtime,
      "/workspace",
      options,
    )

    expect(ensureConnected).toHaveBeenCalledWith([
      { name: "docs", command: "docs" },
    ])
    expect(catalog.commands).toHaveLength(1)
    expect(catalog.commands[0]).toMatchObject({
      serverName: "docs",
      name: "review",
    })
  })

  it("rejects stale revisions and unknown opaque prompt ids", async () => {
    const { runtime, options } = fixture()
    const catalog = buildRemoteMcpPromptCatalog([prompt])

    await expect(resolveServerMcpPrompt(runtime, "/workspace", {
      revision: `sha256:${"0".repeat(64)}`,
      promptId: catalog.commands[0]!.promptId,
      arguments: { target: "src" },
    }, undefined, options)).rejects.toBeInstanceOf(
      McpPromptCatalogConflictError,
    )

    await expect(resolveServerMcpPrompt(runtime, "/workspace", {
      revision: catalog.revision,
      promptId: `mcp_prompt_${"0".repeat(64)}`,
      arguments: { target: "src" },
    }, undefined, options)).rejects.toBeInstanceOf(McpPromptNotFoundError)
  })

  it("resolves a current opaque id to bounded user input", async () => {
    const { runtime, options, getPrompt } = fixture()
    const catalog = await getServerMcpPromptCatalog(
      runtime,
      "/workspace",
      options,
    )
    const result = await resolveServerMcpPrompt(runtime, "/workspace", {
      revision: catalog.revision,
      promptId: catalog.commands[0]!.promptId,
      arguments: { target: "src" },
    }, undefined, options)

    expect(getPrompt).toHaveBeenCalledWith(
      "docs",
      "review",
      { target: "src" },
      undefined,
    )
    expect(result).toEqual({
      input: [{ type: "text", text: "Review src" }],
    })
  })
})
