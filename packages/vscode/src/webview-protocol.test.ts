import { describe, expect, it } from "vitest"

import {
  WebviewProtocolError,
  isLoopbackHttpUrl,
  parseExternalHttpUrl,
  parseWebviewInboundMessage,
  resolveVectorDbRequest,
} from "./webview-protocol.js"

describe("webview host protocol", () => {
  it("accepts a bounded, known request without changing its values", () => {
    const request = {
      type: "newMessage",
      clientMessageId: "local-user-1",
      content: "fix the failing test",
      mode: "debug",
      presetName: "Careful",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    } as const

    expect(parseWebviewInboundMessage(request)).toEqual({
      kind: "request",
      message: request,
    })
  })

  it("accepts the fieldless slash catalog refresh request exactly", () => {
    expect(
      parseWebviewInboundMessage({ type: "getSlashCommandCatalog" }),
    ).toEqual({
      kind: "request",
      message: { type: "getSlashCommandCatalog" },
    })
    expect(() =>
      parseWebviewInboundMessage({
        type: "getSlashCommandCatalog",
        server: "forged",
      }),
    ).toThrow(/unknown field/i)
  })

  it("accepts only an exact fieldless configuration reload request", () => {
    expect(
      parseWebviewInboundMessage({ type: "reloadConfiguration" }),
    ).toEqual({
      kind: "request",
      message: { type: "reloadConfiguration" },
    })
    expect(() =>
      parseWebviewInboundMessage({
        type: "reloadConfiguration",
        workspace: "/tmp/other",
      }),
    ).toThrow(/unknown field/i)
  })

  it.each([
    null,
    [],
    {},
    { type: "not-a-command" },
    { type: "abort", forged: true },
    { type: "newMessage", content: "missing identity", mode: "agent" },
    {
      type: "newMessage",
      clientMessageId: "forged-review-mode",
      content: "not a review command",
      mode: "review",
    },
    { type: "setMode", mode: "root" },
    { type: "setMode", mode: "review" },
    { type: "openFileAtLocation", path: "../outside", line: 0 },
    { type: "fetchMarketplaceData", skillPage: 0 },
  ])("rejects unknown, malformed, or over-permissive requests: %j", (input) => {
    expect(() => parseWebviewInboundMessage(input)).toThrow(
      WebviewProtocolError,
    )
  })

  it("rejects oversized and structurally abusive payloads before dispatch", () => {
    expect(() =>
      parseWebviewInboundMessage({
        type: "newMessage",
        clientMessageId: "local-user-oversized",
        content: "x".repeat(1_000_001),
        mode: "agent",
      }),
    ).toThrow(/content|large|limit/i)

    expect(() =>
      parseWebviewInboundMessage({
        type: "questionnaireResponse",
        requestId: "request",
        answers: Array.from({ length: 129 }, (_, index) => ({
          questionId: `q-${index}`,
          customText: "answer",
        })),
      }),
    ).toThrow(/answers|large|limit/i)
  })

  it.each([
    {
      type: "questionnaireResponse",
      requestId: "request",
      answers: [],
    },
    {
      type: "questionnaireResponse",
      requestId: "request",
      answers: [
        { questionId: "q1", optionId: "a" },
        { questionId: "q1", optionId: "b" },
      ],
    },
    {
      type: "questionnaireResponse",
      requestId: "request",
      answers: [{ questionId: "q1", customText: "missing selection" }],
    },
    {
      type: "questionnaireResponse",
      requestId: "request",
      answers: [
        {
          questionId: "q1",
          optionId: "a",
          optionIds: ["b"],
        },
      ],
    },
  ])("rejects invalid questionnaire response contracts: %j", (input) => {
    expect(() => parseWebviewInboundMessage(input)).toThrow(
      WebviewProtocolError,
    )
  })

  it("counts object-key characters toward the aggregate payload limit", () => {
    const oversizedKey = "k".repeat(24 * 1024 * 1024 + 1)
    let code: WebviewProtocolError["code"] | undefined

    try {
      parseWebviewInboundMessage({ type: "abort", [oversizedKey]: 0 })
    } catch (error) {
      if (error instanceof WebviewProtocolError) code = error.code
    }

    expect(code).toBe("payload_limit")
  })

  it("validates config patches and rejects unknown nested fields", () => {
    expect(
      parseWebviewInboundMessage({
        type: "saveConfig",
        config: {
          model: {
            provider: "openai",
            id: "gpt-test",
            temperature: 0.2,
          },
          skillsConfig: [{ path: ".nexus/skills/review", enabled: true }],
        },
      }),
    ).toMatchObject({ kind: "request" })

    expect(() =>
      parseWebviewInboundMessage({
        type: "saveConfig",
        config: {
          model: {
            provider: "openai",
            id: "gpt-test",
            arbitraryExecutable: "/tmp/payload",
          },
        },
      }),
    ).toThrow(/config|unknown/i)
  })

  it("accepts marketplace mutations only as catalog references", () => {
    expect(
      parseWebviewInboundMessage({
        type: "installMarketplaceItem",
        item: { id: "github", type: "mcp" },
        options: {
          target: "project",
          parameters: { token: "value", __method: "stdio" },
        },
      }),
    ).toMatchObject({
      kind: "request",
      message: {
        item: { id: "github", type: "mcp" },
      },
    })

    expect(() =>
      parseWebviewInboundMessage({
        type: "installMarketplaceItem",
        mpItem: {
          id: "forged",
          type: "skill",
          content: "https://attacker.invalid/payload.tar.gz",
        },
        mpInstallOptions: { target: "global" },
      }),
    ).toThrow(WebviewProtocolError)
  })

  it("keeps bounded diagnostics separate from controller requests", () => {
    expect(
      parseWebviewInboundMessage({
        type: "webviewRuntimeError",
        message: "render failed",
        source: "app.js",
        line: 4,
        column: 9,
      }),
    ).toEqual({
      kind: "diagnostic",
      message: {
        type: "webviewRuntimeError",
        message: "render failed",
        source: "app.js",
        line: 4,
        column: 9,
      },
    })
  })
})

describe("webview URL capabilities", () => {
  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["http://127.0.0.1:6333/", "http://127.0.0.1:6333/"],
  ])("accepts exact HTTP(S) URLs", (input, expected) => {
    expect(parseExternalHttpUrl(input).toString()).toBe(expected)
  })

  it.each([
    "javascript:alert(1)",
    "httpjavascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "https://example.com/\nmalformed",
  ])("rejects unsafe external URL %s", (input) => {
    expect(() => parseExternalHttpUrl(input)).toThrow(WebviewProtocolError)
  })

  it.each([
    "http://localhost:6333",
    "http://127.0.0.1:6333",
    "https://[::1]:6333",
  ])("recognizes loopback destinations: %s", (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(true)
  })

  it.each([
    "https://qdrant.example.com",
    "http://10.0.0.8:6333",
    "file:///tmp/qdrant",
  ])("does not treat non-loopback destinations as local: %s", (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(false)
  })

  it("requires confirmation only for loopback auto-start", () => {
    expect(
      resolveVectorDbRequest("http://127.0.0.1:6333", true),
    ).toEqual({
      url: "http://127.0.0.1:6333/",
      autoStart: true,
      requiresConfirmation: true,
    })
    expect(
      resolveVectorDbRequest("https://qdrant.example.com", false),
    ).toEqual({
      url: "https://qdrant.example.com/",
      autoStart: false,
      requiresConfirmation: false,
    })
  })

  it("refuses to auto-start a process for a non-loopback destination", () => {
    expect(() =>
      resolveVectorDbRequest("https://qdrant.example.com", true),
    ).toThrow(/loopback|local/i)
  })

  it("does not manage a local vector database from a remote runtime UI", () => {
    expect(() =>
      resolveVectorDbRequest(
        "http://127.0.0.1:6333",
        false,
        "remote",
      ),
    ).toThrow(/remote.*runtime host/i)
  })
})
