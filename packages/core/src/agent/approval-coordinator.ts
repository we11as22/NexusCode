import type {
  ApprovalAction,
  IHost,
  PermissionResult,
} from "../types.js"

const approvalScopeSymbol = Symbol.for("@nexuscode/approval-scope")
const approvalTails = new WeakMap<object, Promise<void>>()

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
): Promise<PermissionResult> {
  const scope = approvalScope(host)
  const previous = approvalTails.get(scope) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  approvalTails.set(scope, tail)

  await previous.catch(() => undefined)
  try {
    host.emit({ type: "tool_approval_needed", action, partId })
    return await host.showApprovalDialog(action)
  } finally {
    release()
    if (approvalTails.get(scope) === tail) approvalTails.delete(scope)
  }
}
