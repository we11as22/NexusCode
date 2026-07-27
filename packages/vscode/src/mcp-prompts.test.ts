import { describe, expect, it, vi } from "vitest"
import { SessionProtocolError } from "@nexuscode/core"

import {
  getMcpPromptCommandCatalog,
  getRemoteMcpPromptCommandCatalog,
  isMcpPromptCommandName,
  mcpPromptCommandName,
  resolveMcpPromptCommand,
  resolveRemoteMcpPromptCommand,
} from "./mcp-prompts.js"

const prompt = {
  serverName: "team tools",
  name: "review:code",
  title: "Review code",
  description: "Review a target with optional focus",
  arguments: [
    { name: "target", required: true },
    { name: "focus", required: false },
  ],
}

describe("VS Code MCP prompt commands", () => {
  it("publishes stable canonical command identities and argument hints", () => {
    const client = {
      getPromptCatalog: () => [prompt],
      getPrompt: vi.fn(),
    }

    expect(mcpPromptCommandName(prompt)).toBe(
      "mcp:team%20tools:review%3Acode",
    )
    expect(getMcpPromptCommandCatalog(client)).toEqual([
      {
        name: "mcp:team%20tools:review%3Acode",
        description: "Review a target with optional focus",
        argumentHint: "<target> [focus]",
      },
    ])
  })

  it("resolves quoted positional and named arguments and never renders base64", async () => {
    const getPrompt = vi.fn(async () => ({
      serverName: prompt.serverName,
      name: prompt.name,
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: "Review src/app.ts" } },
        {
          role: "assistant" as const,
          content: {
            type: "image" as const,
            mimeType: "image/png",
            data: "secret-base64-payload",
          },
        },
        {
          role: "user" as const,
          content: {
            type: "resource_link" as const,
            uri: "file:///workspace/checklist.md",
            name: "checklist",
          },
        },
      ],
    }))
    const client = {
      getPromptCatalog: () => [prompt],
      getPrompt,
    }

    const result = await resolveMcpPromptCommand(
      client,
      mcpPromptCommandName(prompt),
      '"src/app.ts" focus="security and races"',
    )

    expect(getPrompt).toHaveBeenCalledWith(
      "team tools",
      "review:code",
      {
        target: "src/app.ts",
        focus: "security and races",
      },
      undefined,
    )
    expect(result).toMatchObject({ status: "resolved" })
    if (result.status !== "resolved") throw new Error("expected resolution")
    expect(result.prompt).toContain("User:\nReview src/app.ts")
    expect(result.prompt).toContain("Assistant:\n[MCP image: image/png]")
    expect(result.prompt).toContain(
      "[MCP resource link: checklist — file:///workspace/checklist.md]",
    )
    expect(result.prompt).not.toContain("secret-base64-payload")
  })

  it("fails closed for ambiguous compatibility aliases", async () => {
    const client = {
      getPromptCatalog: () => [
        { ...prompt, serverName: "team tools", name: "review" },
        { ...prompt, serverName: "team@tools", name: "review" },
      ],
      getPrompt: vi.fn(),
    }

    await expect(
      resolveMcpPromptCommand(client, "mcp__team_tools__review", ""),
    ).resolves.toEqual({
      status: "ambiguous",
      candidates: [
        "mcp:team%20tools:review",
        "mcp:team%40tools:review",
      ],
    })
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it("rejects malformed or excessive arguments before prompts/get", async () => {
    const client = {
      getPromptCatalog: () => [prompt],
      getPrompt: vi.fn(),
    }
    const name = mcpPromptCommandName(prompt)

    await expect(
      resolveMcpPromptCommand(client, name, '"unterminated'),
    ).rejects.toThrow(/unclosed quote/i)
    await expect(
      resolveMcpPromptCommand(client, name, "target=a target=b"),
    ).rejects.toThrow(/duplicate/i)
    await expect(
      resolveMcpPromptCommand(client, name, "a b c"),
    ).rejects.toThrow(/too many positional/i)
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it("recognizes both canonical and compatibility MCP namespaces", () => {
    expect(isMcpPromptCommandName("mcp:server:prompt")).toBe(true)
    expect(isMcpPromptCommandName("mcp__server__prompt")).toBe(true)
    expect(isMcpPromptCommandName("project:review")).toBe(false)
  })

  it("projects and resolves server-owned prompts without exposing opaque ids", async () => {
    const catalog = {
      revision: `sha256:${"a".repeat(64)}`,
      commands: [{
        promptId: `mcp_prompt_${"b".repeat(64)}`,
        commandName: "mcp:docs:review",
        serverName: "docs",
        name: "review",
        description: "Review a target",
        arguments: [{ name: "target", required: true }],
      }],
    } as const
    const client = {
      getMcpPromptCatalog: vi.fn(async () => catalog),
      resolveMcpPrompt: vi.fn(async () => ({
        input: [{ type: "text" as const, text: "User:\nReview src/app.ts" }],
      })),
    }
    const signal = new AbortController().signal

    expect(getRemoteMcpPromptCommandCatalog(catalog)).toEqual([{
      name: "mcp:docs:review",
      description: "Review a target",
      argumentHint: "<target>",
    }])

    await expect(resolveRemoteMcpPromptCommand(
      client,
      "session-1",
      "mcp:docs:review",
      '"src/app.ts"',
      signal,
    )).resolves.toEqual({
      status: "resolved",
      prompt: "User:\nReview src/app.ts",
    })
    expect(client.resolveMcpPrompt).toHaveBeenCalledWith(
      "session-1",
      {
        revision: catalog.revision,
        promptId: catalog.commands[0].promptId,
        arguments: { target: "src/app.ts" },
      },
      signal,
    )
    expect(getRemoteMcpPromptCommandCatalog(catalog)[0]).not.toHaveProperty(
      "promptId",
    )
  })

  it("refreshes and retries a stale remote selection exactly once by canonical command", async () => {
    const first = {
      revision: `sha256:${"a".repeat(64)}`,
      commands: [{
        promptId: `mcp_prompt_${"b".repeat(64)}`,
        commandName: "mcp:docs:review",
        serverName: "docs",
        name: "review",
        arguments: [{ name: "target", required: true }],
      }],
    } as const
    const refreshed = {
      revision: `sha256:${"c".repeat(64)}`,
      commands: [{
        ...first.commands[0],
        promptId: `mcp_prompt_${"d".repeat(64)}`,
      }],
    } as const
    const client = {
      getMcpPromptCatalog: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(refreshed),
      resolveMcpPrompt: vi.fn()
        .mockRejectedValueOnce(new SessionProtocolError({
          code: "selection_conflict",
          message: "stale catalog",
          retryable: true,
        }))
        .mockResolvedValueOnce({
          input: [{ type: "text" as const, text: "refreshed prompt" }],
        }),
    }

    await expect(resolveRemoteMcpPromptCommand(
      client,
      "session-1",
      "mcp:docs:review",
      "src",
    )).resolves.toEqual({
      status: "resolved",
      prompt: "refreshed prompt",
    })
    expect(client.getMcpPromptCatalog).toHaveBeenCalledTimes(2)
    expect(client.resolveMcpPrompt).toHaveBeenCalledTimes(2)
    expect(client.resolveMcpPrompt.mock.calls[1]?.[1]).toEqual({
      revision: refreshed.revision,
      promptId: refreshed.commands[0].promptId,
      arguments: { target: "src" },
    })
  })

  it("fails closed when a stale remote command no longer exists uniquely", async () => {
    const first = {
      revision: `sha256:${"a".repeat(64)}`,
      commands: [{
        promptId: `mcp_prompt_${"b".repeat(64)}`,
        commandName: "mcp:docs:review",
        serverName: "docs",
        name: "review",
        arguments: [],
      }],
    } as const
    const refreshed = {
      revision: `sha256:${"c".repeat(64)}`,
      commands: [],
    } as const
    const client = {
      getMcpPromptCatalog: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(refreshed),
      resolveMcpPrompt: vi.fn()
        .mockRejectedValueOnce(new SessionProtocolError({
          code: "selection_conflict",
          message: "stale catalog",
          retryable: true,
        })),
    }

    await expect(resolveRemoteMcpPromptCommand(
      client,
      "session-1",
      "mcp:docs:review",
      "",
    )).rejects.toThrow(/no longer exists uniquely/i)
    expect(client.getMcpPromptCatalog).toHaveBeenCalledTimes(2)
    expect(client.resolveMcpPrompt).toHaveBeenCalledTimes(1)
  })
})
