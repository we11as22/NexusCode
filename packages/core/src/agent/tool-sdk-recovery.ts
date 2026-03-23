/**
 * Vercel AI SDK may emit stream `error` parts when tool-call JSON fails its *SDK-side* Zod check
 * (before our `executeToolCall` strict validation). Those errors must not kill the agent turn:
 * we surface them as a user-role hint so the model can fix args and call the tool again.
 */

export function isAiSdkInvalidToolArgumentsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { name?: string; message?: string }
  if (e.name === "AI_InvalidToolArgumentsError") return true
  if (typeof e.message === "string" && e.message.startsWith("Invalid arguments for tool")) return true
  return false
}

/**
 * User-visible recovery text appended to the session when the SDK rejects a tool call shape.
 */
export function buildUserMessageForInvalidSdkToolArgs(err: Error): string {
  const toolName = (err as { toolName?: string }).toolName
  const toolArgs = (err as { toolArgs?: string }).toolArgs
  const lines = [
    "[Runtime] A tool call was rejected before execution (argument shape/types).",
    err.message,
    ...(toolName ? [`Tool: ${toolName}`] : []),
    ...(typeof toolArgs === "string" && toolArgs.length > 0
      ? [
          "",
          `Raw arguments (correct JSON/types and invoke again): ${toolArgs.length > 2500 ? `${toolArgs.slice(0, 2500)}…` : toolArgs}`,
        ]
      : []),
    "",
    "Fix the parameters (see tool schema / prior validation hints) and call the same tool again in your next step.",
  ]
  return lines.join("\n")
}
