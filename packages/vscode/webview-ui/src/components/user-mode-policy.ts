import type { Mode } from "../stores/chat.js"

/** Review is a command-scoped internal execution mode, never a persistent chat mode. */
export const USER_SELECTABLE_MODES = [
  "agent",
  "plan",
  "ask",
  "debug",
] as const satisfies readonly Mode[]

export type UserSelectableMode = (typeof USER_SELECTABLE_MODES)[number]
