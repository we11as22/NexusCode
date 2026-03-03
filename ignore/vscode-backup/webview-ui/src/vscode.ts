// Type-safe VS Code webview API bridge

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null

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
