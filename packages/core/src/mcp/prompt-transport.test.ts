import { describe, expect, it } from "vitest"

import {
  buildRemoteMcpPromptCatalog,
  mcpPromptCommandName,
  mcpPromptOpaqueId,
  RemoteMcpPromptResolveRequestSchema,
} from "./prompt-transport.js"

describe("remote MCP prompt transport", () => {
  it("builds stable opaque ids, canonical command names, and revisions", () => {
    const prompts = [{
      serverName: "team/calendar",
      name: "daily review",
      description: "Review the day",
      arguments: [{ name: "date", required: true }],
    }]
    const first = buildRemoteMcpPromptCatalog(prompts)
    const second = buildRemoteMcpPromptCatalog([...prompts])

    expect(first).toEqual(second)
    expect(first.commands[0]).toMatchObject({
      promptId: mcpPromptOpaqueId("team/calendar", "daily review"),
      commandName: mcpPromptCommandName("team/calendar", "daily review"),
      serverName: "team/calendar",
      name: "daily review",
    })
    expect(first.commands[0]?.commandName).toBe(
      "mcp:team%2Fcalendar:daily%20review",
    )
  })

  it("changes revision with catalog semantics, independent of input order", () => {
    const alpha = {
      serverName: "a",
      name: "one",
      arguments: [] as const,
    }
    const beta = {
      serverName: "b",
      name: "two",
      arguments: [] as const,
    }
    expect(
      buildRemoteMcpPromptCatalog([alpha, beta]).revision,
    ).toBe(
      buildRemoteMcpPromptCatalog([beta, alpha]).revision,
    )
    expect(
      buildRemoteMcpPromptCatalog([alpha]).revision,
    ).not.toBe(
      buildRemoteMcpPromptCatalog([{
        ...alpha,
        description: "changed",
      }]).revision,
    )
  })

  it("rejects oversized or malformed resolve arguments", () => {
    const base = {
      revision: `sha256:${"a".repeat(64)}`,
      promptId: `mcp_prompt_${"b".repeat(64)}`,
    }
    expect(RemoteMcpPromptResolveRequestSchema.safeParse({
      ...base,
      arguments: { target: "src" },
    }).success).toBe(true)
    expect(RemoteMcpPromptResolveRequestSchema.safeParse({
      ...base,
      arguments: { target: "x".repeat(16 * 1024 + 1) },
    }).success).toBe(false)
    expect(RemoteMcpPromptResolveRequestSchema.safeParse({
      ...base,
      arguments: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`arg-${index}`, "x"]),
      ),
    }).success).toBe(false)
  })
})
