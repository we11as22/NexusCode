import type { HostCapabilities, ToolDef } from "../types.js"

export function filterToolsForHostCapabilities(
  tools: readonly ToolDef[],
  capabilities: HostCapabilities | undefined,
): ToolDef[] {
  if (capabilities?.interactiveQuestions === true) return [...tools]
  return tools.filter((tool) => tool.name !== "AskFollowupQuestion")
}
