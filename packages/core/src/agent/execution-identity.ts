import { createHash } from "node:crypto"

import type {
  AgentExecutionIdentity,
  ToolExecutionIdentity,
} from "../types.js"

const MAX_ID_LENGTH = 512

function assertId(label: string, value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value.includes("\0")
  ) {
    throw new Error(
      `Agent execution ${label} must be a 1-${MAX_ID_LENGTH} character NUL-free string`,
    )
  }
}

export function assertAgentExecutionIdentity(
  identity: AgentExecutionIdentity,
): void {
  assertId("workspaceId", identity.workspaceId)
  assertId("sessionId", identity.sessionId)
  assertId("turnId", identity.turnId)
  assertId("runId", identity.runId)
}

export function toolExecutionIdentity(
  base: AgentExecutionIdentity,
  input: {
    messageId: string
    partId: string
    toolCallId: string
  },
): ToolExecutionIdentity {
  assertAgentExecutionIdentity(base)
  assertId("messageId", input.messageId)
  assertId("partId", input.partId)
  assertId("toolCallId", input.toolCallId)
  return Object.freeze({
    ...base,
    ...input,
  })
}

export function delegatedAgentExecutionIdentity(
  parent: ToolExecutionIdentity,
  input: {
    workspaceId?: string
    sessionId: string
    subagentId: string
  },
): AgentExecutionIdentity {
  const lineage = createHash("sha256")
    .update(parent.workspaceId)
    .update("\0")
    .update(parent.sessionId)
    .update("\0")
    .update(parent.turnId)
    .update("\0")
    .update(parent.runId)
    .update("\0")
    .update(parent.messageId)
    .update("\0")
    .update(parent.partId)
    .update("\0")
    .update(parent.toolCallId)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.subagentId)
    .digest("hex")
  const identity = {
    workspaceId: input.workspaceId ?? parent.workspaceId,
    sessionId: input.sessionId,
    turnId: `turn_subagent_${lineage}`,
    runId: input.subagentId,
  }
  assertAgentExecutionIdentity(identity)
  return Object.freeze(identity)
}
