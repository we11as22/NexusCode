import type { Mode } from "@nexuscode/core"

export const RUNTIME_MODES = [
  "agent",
  "plan",
  "ask",
  "debug",
] as const satisfies readonly Mode[]
type RuntimeMode = (typeof RUNTIME_MODES)[number]

export function resolveRuntimeServerUrl(
  explicit: string | null | undefined,
  environment: string | null | undefined,
): string | null {
  const value = explicit?.trim() || environment?.trim()
  return value || null
}

export function resolveRuntimeMode(raw: string | undefined): Mode {
  if (RUNTIME_MODES.includes(raw as RuntimeMode)) return raw as RuntimeMode
  throw new Error(
    `Invalid mode: ${raw ?? ""}. Expected agent, plan, ask, or debug. Use /review for a reviewer turn.`,
  )
}

export function cycleRuntimeMode(current: string): Mode {
  const index = RUNTIME_MODES.indexOf(current as RuntimeMode)
  return RUNTIME_MODES[(index + 1) % RUNTIME_MODES.length] ?? "agent"
}

export async function selectSession<T extends { id: string }>(options: {
  sessionId?: string | null
  continueSession: boolean
  list: () => Promise<Array<{ id: string }>>
  load: (id: string) => Promise<T | null>
  create: () => Promise<T>
}): Promise<T> {
  const requested = options.sessionId?.trim()
  if (requested) {
    const session = await options.load(requested)
    if (!session) throw new Error(`Session not found: ${requested}`)
    return session
  }

  if (options.continueSession) {
    const latest = (await options.list())[0]
    if (latest) {
      const session = await options.load(latest.id)
      if (session) return session
    }
  }
  return options.create()
}
