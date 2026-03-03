// Type-safe VS Code webview API bridge

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null

const pendingConfirms = new Map<string, (ok: boolean) => void>()

export function getVsCode() {
  if (!vscodeApi) {
    if (typeof acquireVsCodeApi !== "undefined") {
      vscodeApi = acquireVsCodeApi()
    } else {
      // Dev mode mock
      vscodeApi = {
        postMessage: (msg: unknown) => console.log("[dev] postMessage:", msg),
        getState: () => null,
        setState: () => {},
      }
    }
  }
  return vscodeApi
}

export function postMessage(msg: unknown): void {
  getVsCode().postMessage(msg)
}

/** Show confirm dialog via extension (webview sandbox has no window.confirm). */
export function confirmAsync(message: string): Promise<boolean> {
  const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve)
    postMessage({ type: "showConfirm", id, message })
  })
}

/** Called when extension sends confirmResult — resolves the matching confirmAsync. */
export function resolveConfirm(id: string, ok: boolean): void {
  const resolve = pendingConfirms.get(id)
  if (resolve) {
    pendingConfirms.delete(id)
    resolve(ok)
  }
}
