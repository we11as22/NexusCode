import { describe, expect, it } from "vitest"

import {
  projectAgentEventForWebview,
  projectExtensionMessageForWebview,
  projectSessionMessagesForWebview,
  windowSessionMessagesForWebview,
} from "./webview-projection.js"

describe("webview output projection", () => {
  it("bounds long live transcripts to the newest requested window", () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index}`,
      ts: index,
      role: "user" as const,
      content: `message ${index}`,
    }))

    const visible = windowSessionMessagesForWebview(messages, 200)

    expect(visible).toHaveLength(200)
    expect(visible[0]?.id).toBe("message-800")
    expect(visible.at(-1)?.id).toBe("message-999")
    expect(messages).toHaveLength(1_000)
  })

  it("removes legacy absolute spill paths while preserving opaque artifacts", () => {
    const messages = [
      {
        id: "message-1",
        ts: 1,
        role: "assistant" as const,
        content: [
          {
            type: "tool" as const,
            id: "part-1",
            tool: "Bash",
            status: "completed" as const,
            output: "bounded output",
            outputSpillPath:
              "/Users/alice/.nexus/data/tool-output/session/artifact.out",
            outputArtifactId:
              "artifact_00000000-0000-4000-8000-000000000000",
            outputArtifactOwnerSessionId: "private-session-id",
            backgroundTaskId: "bash-task-1",
            path: "src/index.ts",
            diffStats: { added: 1, removed: 1 },
            diffHunks: [
              { type: "remove" as const, lineNum: 2, line: "BETA" },
              { type: "add" as const, lineNum: 2, line: "GAMMA" },
            ],
            appliedReplacements: [
              { oldSnippet: "BETA", newSnippet: "GAMMA" },
            ],
            changeFiles: [{
              path: "src/index.ts",
              operation: "modify" as const,
              diffStats: { added: 1, removed: 1 },
              binary: false,
              diffHunks: [
                { type: "remove" as const, lineNum: 2, line: "BETA" },
                { type: "add" as const, lineNum: 2, line: "GAMMA" },
              ],
            }],
          },
        ],
      },
    ]

    const projected = projectSessionMessagesForWebview(messages)
    const part = projected[0]!.content[0] as unknown as Record<string, unknown>

    expect(part).not.toHaveProperty("outputSpillPath")
    expect(part).not.toHaveProperty("outputArtifactOwnerSessionId")
    expect(part.outputArtifactId).toBe(
      "artifact_00000000-0000-4000-8000-000000000000",
    )
    expect(part.path).toBe("src/index.ts")
    expect(part.backgroundTaskId).toBe("bash-task-1")
    expect(part.diffHunks).toEqual([
      { type: "remove", lineNum: 2, line: "BETA" },
      { type: "add", lineNum: 2, line: "GAMMA" },
    ])
    expect(part.appliedReplacements).toEqual([
      { oldSnippet: "BETA", newSnippet: "GAMMA" },
    ])
    expect(part.changeFiles).toEqual([{
      path: "src/index.ts",
      operation: "modify",
      diffStats: { added: 1, removed: 1 },
      binary: false,
      diffHunks: [
        { type: "remove", lineNum: 2, line: "BETA" },
        { type: "add", lineNum: 2, line: "GAMMA" },
      ],
    }])
    expect(
      (messages[0]!.content[0] as { outputSpillPath?: string }).outputSpillPath,
    ).toContain("/Users/alice/")
  })

  it("removes private output locations recursively from tool metadata", () => {
    const event = {
      type: "tool_end" as const,
      tool: "Bash",
      partId: "part-1",
      messageId: "message-1",
      success: true,
      path: "src/index.ts",
      metadata: {
        outputSpillPath: "/tmp/full.out",
        outputPath: "/tmp/output",
        nested: {
          absolutePath: "/tmp/artifact",
          absoluteFilePath: "/tmp/file",
          artifactPath: "/tmp/artifact-2",
          spillPath: "/tmp/spill",
          artifactId: "artifact-safe",
          path: "src/index.ts",
        },
      },
    }

    const projected = projectAgentEventForWebview(event)

    expect(projected).toMatchObject({
      type: "tool_end",
      path: "src/index.ts",
      metadata: {
        nested: {
          artifactId: "artifact-safe",
          path: "src/index.ts",
        },
      },
    })
    expect(JSON.stringify(projected)).not.toContain("/tmp/")
    expect(event.metadata.outputSpillPath).toBe("/tmp/full.out")
  })

  it("applies the projection at both state and live-event envelopes", () => {
    const stateMessage = projectExtensionMessageForWebview({
      type: "stateUpdate",
      state: {
        messages: [
          {
            id: "message-1",
            ts: 1,
            role: "assistant",
            content: [
              {
                type: "tool",
                id: "part-1",
                tool: "Bash",
                status: "completed",
                outputSpillPath: "/private/history.out",
                outputArtifactId: "artifact-safe",
              },
            ],
          },
        ],
      },
    })
    const liveMessage = projectExtensionMessageForWebview({
      type: "agentEvent",
      event: {
        type: "tool_end",
        metadata: { outputSpillPath: "/private/live.out" },
      },
    })

    expect(JSON.stringify(stateMessage)).not.toContain("/private/history.out")
    expect(JSON.stringify(stateMessage)).toContain("artifact-safe")
    expect(JSON.stringify(liveMessage)).not.toContain("/private/live.out")
  })

  it("returns unrelated messages unchanged", () => {
    const message = {
      type: "indexStatus",
      status: { state: "ready", files: 3, symbols: 7 },
    } as const

    expect(projectExtensionMessageForWebview(message)).toBe(message)
  })
})
