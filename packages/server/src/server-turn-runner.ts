import { createHash } from "node:crypto"

import {
  LegacyAgentEventSchema,
  Session,
  deriveSessionTitle,
  hashWorkspaceIdentity,
  loadSession,
  saveSession,
  type AgentEvent,
  type ApprovalAction,
  type MessagePart,
  type Mode,
  type NonPlanMode,
  type NexusRunServices,
  type ProviderContextAnchor,
  type SessionMessage,
  type StoredContextUsage,
  type TurnRunner,
  type TurnRunnerContext,
  type TurnRunnerResult,
} from "@nexuscode/core"
import { SessionRuntimeRepository } from "@nexuscode/state"

import { runSession } from "./run-session.js"
import { SessionApprovalBroker } from "./session-approval-broker.js"
import {
  ensureSessionOnDisk,
} from "./session-fs-store.js"

function approvalId(turnId: string, partId: string): string {
  return `approval-${createHash("sha256")
    .update(turnId)
    .update("\0")
    .update(partId)
    .digest("hex")
    .slice(0, 40)}`
}

function inputContent(context: TurnRunnerContext): string | MessagePart[] {
  const parts: MessagePart[] = context.input.parts.map((part): MessagePart => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
        ...(part.user_message ? { user_message: part.user_message } : {}),
      }
    }
    if (part.type === "image") {
      return {
        type: "image",
        mimeType: part.mimeType,
        data: part.data,
      }
    }
    if (part.type === "mention") {
      return {
        type: "text",
        text: `@${part.name} (${part.path})`,
      }
    }
    return { type: "text", text: `$${part.name}` }
  })
  return parts.length === 1 &&
    parts[0]?.type === "text" &&
    !parts[0].user_message
    ? parts[0].text
    : parts
}

function textPreview(content: string | MessagePart[]): string {
  if (typeof content === "string") return content
  return content
    .filter((part): part is Extract<MessagePart, { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
}

export interface ServerTurnRunnerOptions {
  readonly canonicalDirectory: string
  readonly state: SessionRuntimeRepository
  readonly approvals: SessionApprovalBroker
  readonly services?: NexusRunServices
  readonly execute?: typeof runSession
  readonly sessions?: ServerTurnSessionStore
}

export interface ServerTurnSessionStore {
  ensure(
    sessionId: string,
    cwd: string,
  ): Promise<{ messageCount: number; revision: number }>
  load(
    sessionId: string,
    cwd: string,
  ): Promise<{
    messages: SessionMessage[]
    revision: number
    title?: string
    todo?: string
    mode?: Mode
    planReturnMode?: NonPlanMode
    contextUsage?: StoredContextUsage
    providerContextAnchor?: ProviderContextAnchor
  }>
  checkpoint(
    sessionId: string,
    cwd: string,
    snapshot: {
      messages: SessionMessage[]
      title?: string
      todo?: string
      mode?: Mode
      planReturnMode?: NonPlanMode
      contextUsage?: StoredContextUsage
      providerContextAnchor?: ProviderContextAnchor
    },
    expectedRevision: number,
  ): Promise<number>
}

class DurableServerSession extends Session {
  readonly #store: ServerTurnSessionStore
  readonly #sessionId: string
  readonly #cwd: string
  #revision: number
  #title: string | undefined

  constructor(input: {
    sessionId: string
    cwd: string
    messages: SessionMessage[]
    revision: number
    title?: string
    todo?: string
    mode?: Mode
    planReturnMode?: NonPlanMode
    contextUsage?: StoredContextUsage
    providerContextAnchor?: ProviderContextAnchor
    store: ServerTurnSessionStore
  }) {
    // Persistence is owned by this adapter, not Session's global store.
    super(
      input.sessionId,
      input.cwd,
      input.messages,
      input.todo,
      true,
      input.contextUsage,
      input.revision,
      input.providerContextAnchor,
      input.mode,
      input.planReturnMode,
    )
    this.#store = input.store
    this.#sessionId = input.sessionId
    this.#cwd = input.cwd
    this.#revision = input.revision
    this.#title = input.title
  }

  override async save(): Promise<void> {
    const title =
      this.#title ?? (deriveSessionTitle(this.messages) || undefined)
    const messages = structuredClone(this.messages)
    const contextUsage = this.getLastContextUsageSnapshot()
    const providerContextAnchor = this.getProviderContextAnchor()
    this.#revision = await this.#store.checkpoint(
      this.#sessionId,
      this.#cwd,
      {
        messages,
        ...(title ? { title } : {}),
        ...(this.getTodo() ? { todo: this.getTodo() } : {}),
        ...(this.getMode() ? { mode: this.getMode() } : {}),
        ...(this.getPlanReturnMode()
          ? { planReturnMode: this.getPlanReturnMode() }
          : {}),
        ...(contextUsage ? { contextUsage: { ...contextUsage } } : {}),
        ...(providerContextAnchor
          ? { providerContextAnchor: { ...providerContextAnchor } }
          : {}),
      },
      this.#revision,
    )
    this.#title = title
  }
}

export class ServerTurnRunner implements TurnRunner {
  readonly #canonicalDirectory: string
  readonly #state: SessionRuntimeRepository
  readonly #approvals: SessionApprovalBroker
  readonly #services: NexusRunServices | undefined
  readonly #execute: typeof runSession
  readonly #sessions: ServerTurnSessionStore

  constructor(options: ServerTurnRunnerOptions) {
    this.#canonicalDirectory = options.canonicalDirectory
    this.#state = options.state
    this.#approvals = options.approvals
    this.#services = options.services
    this.#execute = options.execute ?? runSession
    this.#sessions = options.sessions ?? {
      ensure: ensureSessionOnDisk,
      load: async (sessionId, cwd) => {
        const stored = await loadSession(sessionId, cwd)
        if (!stored) throw new Error(`Session not found: ${sessionId}`)
        return {
          messages: stored.messages,
          revision: stored.revision ?? 0,
          ...(stored.title ? { title: stored.title } : {}),
          ...(stored.todo ? { todo: stored.todo } : {}),
          ...(stored.mode ? { mode: stored.mode } : {}),
          ...(stored.planReturnMode
            ? { planReturnMode: stored.planReturnMode }
            : {}),
          ...(stored.contextUsage
            ? { contextUsage: stored.contextUsage }
            : {}),
          ...(stored.providerContextAnchor
            ? { providerContextAnchor: stored.providerContextAnchor }
            : {}),
        }
      },
      checkpoint: async (
        sessionId,
        cwd,
        snapshot,
        expectedRevision,
      ) => saveSession(
        {
          id: sessionId,
          cwd,
          ts: Date.now(),
          messages: snapshot.messages,
          ...(snapshot.title ? { title: snapshot.title } : {}),
          ...(snapshot.todo ? { todo: snapshot.todo } : {}),
          ...(snapshot.mode ? { mode: snapshot.mode } : {}),
          ...(snapshot.planReturnMode
            ? { planReturnMode: snapshot.planReturnMode }
            : {}),
          ...(snapshot.contextUsage
            ? { contextUsage: snapshot.contextUsage }
            : {}),
          ...(snapshot.providerContextAnchor
            ? { providerContextAnchor: snapshot.providerContextAnchor }
            : {}),
        },
        { expectedRevision },
      ),
    }
  }

  async run(context: TurnRunnerContext): Promise<TurnRunnerResult> {
    await this.#sessions.ensure(
      context.sessionId,
      this.#canonicalDirectory,
    )
    const stored = await this.#sessions.load(
      context.sessionId,
      this.#canonicalDirectory,
    )
    const session = new DurableServerSession({
      sessionId: context.sessionId,
      cwd: this.#canonicalDirectory,
      messages: stored.messages,
      revision: stored.revision,
      store: this.#sessions,
      ...(stored.title ? { title: stored.title } : {}),
      ...(stored.todo ? { todo: stored.todo } : {}),
      ...(stored.mode ? { mode: stored.mode } : {}),
      ...(stored.planReturnMode
        ? { planReturnMode: stored.planReturnMode }
        : {}),
      ...(stored.contextUsage
        ? { contextUsage: stored.contextUsage }
        : {}),
      ...(stored.providerContextAnchor
        ? { providerContextAnchor: stored.providerContextAnchor }
        : {}),
    })
    const content = inputContent(context)
    session.setMode(context.execution.mode)
    session.addMessage(
      {
        role: "user",
        content,
        ...(context.execution.selection
          ? { presetName: context.execution.selection.profileId }
          : {}),
        mode: context.execution.mode,
      },
      { id: context.input.id },
    )
    // The admitted input must be durable before provider/tool execution begins.
    await session.save()

    const onEvent = (candidate: AgentEvent): void => {
      const event = LegacyAgentEventSchema.parse(candidate) as AgentEvent
      if (event.type === "tool_approval_needed") {
        const id = approvalId(context.turnId, event.partId)
        this.#approvals.register({
          approvalId: id,
          turnId: context.turnId,
          action: event.action,
        })
        try {
          this.#state.createApproval({
            approvalId: id,
            sessionId: context.sessionId,
            expectedTurnId: context.turnId,
            toolName: event.action.tool,
            redactedSummary: event.action.description,
            dedupeKey: `${context.turnId}:${id}`,
            fence: context.fence,
          })
        } catch (error) {
          this.#approvals.cancelRegistration({
            approvalId: id,
            turnId: context.turnId,
          })
          throw error
        }
      }
      this.#state.appendAgentEvent({
        sessionId: context.sessionId,
        turnId: context.turnId,
        runId: context.runId,
        event: event as unknown as Readonly<Record<string, unknown>>,
        fence: context.fence,
      })
    }
    const requestApproval = (action: ApprovalAction) =>
      this.#approvals.wait(context.turnId, action, context.signal)

    let result: TurnRunnerResult
    try {
      await this.#execute({
        session,
        executionIdentity: {
          workspaceId: hashWorkspaceIdentity(this.#canonicalDirectory),
          sessionId: context.sessionId,
          turnId: context.turnId,
          runId: context.runId,
        },
        cwd: this.#canonicalDirectory,
        content: textPreview(content),
        mode: context.execution.mode,
        onEvent,
        signal: context.signal,
        requestApproval,
        requestModeChange: async (mode, reason) => {
          try {
            this.#state.requestNextMode({
              sessionId: context.sessionId,
              expectedTurnId: context.turnId,
              mode,
              fence: context.fence,
            })
            session.setMode(mode)
            return {
              success: true,
              mode,
              message:
                `The current response ended and the next turn will use ${mode} mode.` +
                (reason ? ` Reason: ${reason}` : ""),
            }
          } catch (error) {
            return {
              success: false,
              mode,
              message:
                "The server could not durably persist the mode transition: " +
                (error instanceof Error ? error.message : String(error)),
            }
          }
        },
        ...(this.#services ? { services: this.#services } : {}),
        userMessageAdmitted: true,
        ...(context.execution.selection
          ? { profileName: context.execution.selection.profileId }
          : {}),
      })
      result = context.signal.aborted
        ? { status: "interrupted" }
        : { status: "completed" }
    } catch (error) {
      if (context.signal.aborted) {
        result = {
          status: "interrupted",
          error: error instanceof Error ? error.message : String(error),
        }
      } else {
        result = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    try {
      // Catch provider failures and interrupts that happen between loop
      // checkpoints. This preserves partial assistant/tool/compaction evidence.
      await session.save()
    } catch (error) {
      result = {
        status: "failed",
        error:
          `Failed to durably checkpoint session ${context.sessionId}: ` +
          (error instanceof Error ? error.message : String(error)),
      }
    } finally {
      this.#approvals.cancelTurn(context.turnId)
    }
    return result
  }
}
