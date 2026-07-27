import type {
  ApprovalAction,
  IHost,
  PermissionResult,
} from "../types.js"

const approvalScopeSymbol = Symbol.for("@nexuscode/approval-scope")
const approvalTails = new WeakMap<object, Promise<void>>()

export interface HostApprovalRequestOptions {
  signal?: AbortSignal
}

function waitForTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<"ready" | "aborted"> {
  if (!signal) return previous.catch(() => undefined).then(() => "ready")
  if (signal.aborted) return Promise.resolve("aborted")
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: "ready" | "aborted") => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => finish("aborted")
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void previous.catch(() => undefined).then(() => finish("ready"))
  })
}

function waitForDialog(
  dialog: Promise<PermissionResult>,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  if (!signal) return dialog
  if (signal.aborted) return Promise.resolve({ approved: false })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      result: PermissionResult,
      error?: unknown,
    ) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    const onAbort = () => finish({ approved: false })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void dialog.then(
      (result) => finish(result),
      (error) => finish({ approved: false }, error),
    )
  })
}

function approvalScope(host: IHost): object {
  const scoped = host as IHost & { [approvalScopeSymbol]?: object }
  if (scoped[approvalScopeSymbol]) return scoped[approvalScopeSymbol]
  const value = {}
  Object.defineProperty(scoped, approvalScopeSymbol, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return value
}

/**
 * Serialize the event + dialog pair across a root host and all delegated-host
 * proxies. Single-slot TUI/webview approval resolvers must never be overwritten
 * by concurrent subagents.
 */
export async function requestHostApproval(
  host: IHost,
  action: ApprovalAction,
  partId: string,
  options: HostApprovalRequestOptions = {},
): Promise<PermissionResult> {
  const scope = approvalScope(host)
  const previous = approvalTails.get(scope)
  const priorTail = previous ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = priorTail.catch(() => undefined).then(() => gate)
  approvalTails.set(scope, tail)
  void tail.finally(() => {
    if (approvalTails.get(scope) === tail) approvalTails.delete(scope)
  })

  if (previous) {
    const turn = await waitForTurn(previous, options.signal)
    if (turn === "aborted") {
      release()
      return { approved: false }
    }
  } else if (options.signal?.aborted) {
    release()
    return { approved: false }
  }
  let dialog: Promise<PermissionResult> | undefined
  try {
    host.emit({ type: "tool_approval_needed", action, partId })
    dialog = Promise.resolve(
      host.showApprovalDialog(action, options.signal),
    )
    return await waitForDialog(dialog, options.signal)
  } finally {
    if (dialog && options.signal?.aborted) {
      void dialog.catch(() => undefined).finally(release)
    } else {
      release()
    }
  }
}
