import { describe, expect, it } from "vitest"

import {
  projectAgentEventForWebview,
  projectExtensionMessageForWebview,
  projectSessionMessagesForWebview,
} from "./webview-projection.js"

describe("webview output projection", () => {
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
            path: "src/index.ts",
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
