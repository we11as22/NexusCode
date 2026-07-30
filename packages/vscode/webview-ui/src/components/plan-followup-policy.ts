export const PLAN_FOLLOWUP_OPTIONS = [
  {
    id: "implement",
    label: "Yes, implement this plan",
  },
  {
    id: "revise",
    label: "No, and tell Nexus what to do differently",
  },
] as const

export type PlanFollowupSelection =
  | (typeof PLAN_FOLLOWUP_OPTIONS)[number]["id"]
  | "dismiss"

export function planFollowupAction(
  selection: PlanFollowupSelection,
  feedback: string,
):
  | { choice: "implement" }
  | { choice: "revise"; instruction: string }
  | { choice: "abandon" }
  | null {
  if (selection === "dismiss") return { choice: "abandon" }
  if (selection === "implement") return { choice: "implement" }
  const instruction = feedback.trim()
  return instruction ? { choice: "revise", instruction } : null
}
