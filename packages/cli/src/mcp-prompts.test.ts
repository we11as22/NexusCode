import { describe, expect, it, vi } from "vitest"
import {
  SessionProtocolError,
  buildRemoteMcpPromptCatalog,
} from "@nexuscode/core"
import {
  mcpPromptCommandName,
  resolveMcpPromptCommand,
  resolveRemoteMcpPromptCommand,
} from "./mcp-prompts.js"

const prompt = {
  serverName: "git hub",
  name: "review/pr",
  description: "Review",
  arguments: [
    { name: "target", required: true },
    { name: "focus", required: false },
  ],
}

describe("MCP prompt command adapter", () => {
  it("uses an unambiguous escaped command id and parses quoted arguments", async () => {
    const getPrompt = vi.fn(async () => ({
      serverName: prompt.serverName,
      name: prompt.name,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "Review it" },
        },
      ],
    }))
    const client = {
      getPromptCatalog: () => [prompt],
      getPrompt,
    }

    const name = mcpPromptCommandName(prompt)
    expect(name).toBe("mcp:git%20hub:review%2Fpr")
    await expect(
      resolveMcpPromptCommand(
        client as never,
        name,
        '"pull request 12" focus=security',
      ),
    ).resolves.toEqual({
      status: "resolved",
      prompt: "Review it",
    })
    expect(getPrompt).toHaveBeenCalledWith(
      "git hub",
      "review/pr",
      {
        target: "pull request 12",
        focus: "security",
      },
    )
  })

  it("rejects compatibility aliases that collide after normalization", async () => {
    const client = {
      getPromptCatalog: () => [
        { ...prompt, serverName: "a.b", name: "run" },
        { ...prompt, serverName: "a_b", name: "run" },
      ],
      getPrompt: vi.fn(),
    }

    await expect(
      resolveMcpPromptCommand(
        client as never,
        "mcp__a_b__run",
        "",
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      candidates: [
        "mcp:a.b:run",
        "mcp:a_b:run",
      ],
    })
    expect(client.getPrompt).not.toHaveBeenCalled()
  })

  it("resolves remote prompts without starting a local MCP runtime", async () => {
    const catalog = buildRemoteMcpPromptCatalog([prompt])
    const getMcpPromptCatalog = vi.fn(async () => catalog)
    const resolveMcpPrompt = vi.fn(async () => ({
      input: [{ type: "text" as const, text: "Remote review" }],
    }))

    await expect(resolveRemoteMcpPromptCommand(
      { getMcpPromptCatalog, resolveMcpPrompt },
      "session-1",
      catalog.commands[0]!.commandName,
      '"pull request 12" focus=security',
    )).resolves.toEqual({
      status: "resolved",
      prompt: "Remote review",
    })
    expect(resolveMcpPrompt).toHaveBeenCalledWith("session-1", {
      revision: catalog.revision,
      promptId: catalog.commands[0]!.promptId,
      arguments: {
        target: "pull request 12",
        focus: "security",
      },
    })
  })

  it("refreshes exactly once when the remote catalog revision races", async () => {
    const first = buildRemoteMcpPromptCatalog([prompt])
    const second = buildRemoteMcpPromptCatalog([{
      ...prompt,
      description: "Updated description",
    }])
    const getMcpPromptCatalog = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const resolveMcpPrompt = vi.fn()
      .mockRejectedValueOnce(new SessionProtocolError({
        code: "selection_conflict",
        message: "stale",
        retryable: true,
      }))
      .mockResolvedValueOnce({
        input: [{ type: "text" as const, text: "Updated review" }],
      })

    await expect(resolveRemoteMcpPromptCommand(
      { getMcpPromptCatalog, resolveMcpPrompt },
      "session-1",
      first.commands[0]!.commandName,
      "src",
    )).resolves.toEqual({
      status: "resolved",
      prompt: "Updated review",
    })
    expect(getMcpPromptCatalog).toHaveBeenCalledTimes(2)
    expect(resolveMcpPrompt).toHaveBeenNthCalledWith(2, "session-1", {
      revision: second.revision,
      promptId: second.commands[0]!.promptId,
      arguments: { target: "src" },
    })
  })

  it("reparses positional arguments against the refreshed prompt schema", async () => {
    const first = buildRemoteMcpPromptCatalog([prompt])
    const second = buildRemoteMcpPromptCatalog([{
      ...prompt,
      arguments: [
        { name: "repository", required: true },
        { name: "target", required: true },
      ],
    }])
    const getMcpPromptCatalog = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const resolveMcpPrompt = vi.fn()
      .mockRejectedValueOnce(new SessionProtocolError({
        code: "selection_conflict",
        message: "stale",
        retryable: true,
      }))
      .mockResolvedValueOnce({
        input: [{ type: "text" as const, text: "Updated review" }],
      })

    await resolveRemoteMcpPromptCommand(
      { getMcpPromptCatalog, resolveMcpPrompt },
      "session-1",
      first.commands[0]!.commandName,
      "nexus",
    )

    expect(resolveMcpPrompt).toHaveBeenNthCalledWith(2, "session-1", {
      revision: second.revision,
      promptId: second.commands[0]!.promptId,
      arguments: { repository: "nexus" },
    })
  })
})
