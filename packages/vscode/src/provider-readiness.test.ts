import { beforeEach, describe, expect, it, vi } from "vitest"

type ExtensionMessage = {
  type: string
  state?: {
    sessionId: string
    isRunning: boolean
    messages: unknown[]
  }
}

const controllerState = vi.hoisted(() => ({
  post: undefined as ((message: ExtensionMessage) => void) | undefined,
}))

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: Array<{ path?: string } | string>) => ({
      path: parts
        .map((part) => (typeof part === "string" ? part : part.path ?? ""))
        .join("/"),
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine() {},
      dispose() {},
    }),
  },
}))

vi.mock("@nexuscode/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexuscode/core")>()),
  setIndexTelemetrySink() {},
}))

vi.mock("./services/autocomplete/index.js", () => ({
  registerAutocompleteProvider: () => ({
    load: vi.fn(),
  }),
}))

vi.mock("./controller.js", () => ({
  Controller: class {
    constructor(
      _context: unknown,
      post: (message: ExtensionMessage) => void,
    ) {
      controllerState.post = post
    }

    setAutocompleteConfigReady() {}
    getConfig() {
      return {}
    }
    resolveAutocompleteModel() {
      return undefined
    }
    ensureInitialized() {
      return Promise.resolve()
    }
    postStateToWebview() {
      controllerState.post?.({
        type: "stateUpdate",
        state: {
          sessionId: "session-test",
          isRunning: false,
          messages: [],
        },
      })
    }
    handleWebviewMessage(message: { type?: string }) {
      if (
        message.type === "getState" ||
        message.type === "webviewDidLaunch"
      ) {
        this.postStateToWebview()
      }
      return Promise.resolve()
    }
    dispose() {}
  },
}))

import { NexusProvider } from "./provider.js"

describe("NexusProvider webview readiness handshake", () => {
  beforeEach(() => {
    controllerState.post = undefined
  })

  it("does not replay or re-handle the legacy second ready alias", async () => {
    let receive:
      | ((message: unknown) => Promise<void>)
      | undefined
    const delivered: ExtensionMessage[] = []
    const webview = {
      cspSource: "vscode-webview:",
      options: {},
      html: "",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage(
        handler: (message: unknown) => Promise<void>,
      ) {
        receive = handler
        return { dispose() {} }
      },
      async postMessage(message: ExtensionMessage) {
        delivered.push(message)
        return true
      },
    }
    const view = {
      webview,
      visible: true,
      onDidChangeVisibility() {
        return { dispose() {} }
      },
    }
    const context = {
      extensionUri: { path: "/extension" },
    }
    const provider = new NexusProvider(context as never)

    await provider.resolveWebviewView(view as never, {} as never, {} as never)
    await Promise.resolve()
    expect(receive).toBeTypeOf("function")

    await receive?.({ type: "getState" })
    await receive?.({ type: "webviewDidLaunch" })

    expect(delivered.filter((message) => message.type === "stateUpdate"))
      .toHaveLength(2)
    provider.dispose()
  })
})
