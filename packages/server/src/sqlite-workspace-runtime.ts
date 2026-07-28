import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"

import {
  closeNexusRunServices,
  createNexusRunServices,
  ManagedWorkspaceRuntime,
  OrchestrationRuntime,
  getGlobalConfigDir,
  GitService,
  hashWorkspaceIdentity,
  scheduleToolOutputMaintenance,
  type TurnEpochSnapshot,
  type TurnRunner,
  type NexusRunServices,
  type WorkspaceRuntimeFactory,
} from "@nexuscode/core"
import {
  NexusStateDatabase,
  RuntimeRepository,
  SessionRuntimeRepository,
} from "@nexuscode/state"

import { ServerTurnRunner } from "./server-turn-runner.js"
import { ServerHost } from "./host.js"
import { createServerMcpClient } from "./server-capabilities.js"
import { SessionApprovalBroker } from "./session-approval-broker.js"
import { SqliteSessionProtocolService } from "./session-protocol-service.js"
import { SqliteChangeSetStore } from "./sqlite-change-set-store.js"

export interface WorkspaceRunnerFactoryContext {
  readonly canonicalDirectory: string
  readonly state: SessionRuntimeRepository
  readonly approvals: SessionApprovalBroker
  readonly services: NexusRunServices
}

export interface SqliteWorkspaceRuntimeFactoryOptions {
  readonly stateRoot?: string
  readonly ownerId?: string
  readonly now?: () => number
  readonly runnerFactory?: (
    context: WorkspaceRunnerFactoryContext,
  ) => TurnRunner
  readonly epochs?: {
    capture(): TurnEpochSnapshot | PromiseLike<TurnEpochSnapshot>
  }
  readonly onDiagnostic?: (error: unknown) => void
}

function canonicalDirectory(directory: string): string {
  return realpathSync.native(directory)
}

function workspaceDigest(directory: string): string {
  return createHash("sha256")
    .update(canonicalDirectory(directory))
    .digest("hex")
    .slice(0, 32)
}

export function resolveWorkspaceStatePath(
  directory: string,
  stateRoot = getGlobalConfigDir(),
): string {
  return join(
    stateRoot,
    "state",
    "workspaces",
    workspaceDigest(directory),
    "state.sqlite",
  )
}

class RuntimeStateOwner {
  readonly #database: NexusStateDatabase
  readonly #approvals: SessionApprovalBroker
  #closed = false

  constructor(
    database: NexusStateDatabase,
    approvals: SessionApprovalBroker,
  ) {
    this.#database = database
    this.#approvals = approvals
  }

  close(): void {
    if (this.#closed) return
    this.#approvals.close()
    this.#database.close()
    this.#closed = true
  }
}

export function createSqliteWorkspaceRuntimeFactory(
  options: SqliteWorkspaceRuntimeFactoryOptions = {},
): WorkspaceRuntimeFactory {
  const ownerId =
    options.ownerId ?? `server-${process.pid}-${randomUUID()}`
  const epochs = options.epochs ?? {
    capture: () => ({ configEpoch: 0, contextEpoch: 0 }),
  }
  return {
    async create(directory) {
      const canonical = canonicalDirectory(directory)
      const digest = workspaceDigest(canonical)
      const database = NexusStateDatabase.open({
        path: resolveWorkspaceStatePath(
          canonical,
          options.stateRoot ?? getGlobalConfigDir(),
        ),
        processId: `${ownerId}-${digest}`,
        ...(options.now ? { now: options.now } : {}),
      })
      const approvals = new SessionApprovalBroker()
      const host = new ServerHost(canonical, () => {})
      const mcpClient = createServerMcpClient(host)
      const changeWorkspaceId = hashWorkspaceIdentity(canonical)
      const services = createNexusRunServices({
        orchestrationRuntime: new OrchestrationRuntime(canonical),
        mcpClient,
        changeSets: {
          workspaceId: changeWorkspaceId,
          store: new SqliteChangeSetStore(
            database,
            changeWorkspaceId,
            {
              ...(options.now ? { now: options.now } : {}),
            },
          ),
        },
        git: new GitService(canonical),
      })
      const toolOutputMaintenance = scheduleToolOutputMaintenance({
        cwd: canonical,
        services,
        onResult(result) {
          for (const diagnostic of result.errors) {
            options.onDiagnostic?.(
              new Error(`Tool-output maintenance: ${diagnostic}`),
            )
          }
        },
      })
      void toolOutputMaintenance?.promise.catch((error) => {
        options.onDiagnostic?.(error)
      })
      try {
        const state = new SessionRuntimeRepository(database, {
          ...(options.now ? { now: options.now } : {}),
        })
        const runtime = new RuntimeRepository(database, {
          ...(options.now ? { now: options.now } : {}),
        })
        const runner =
          options.runnerFactory?.({
            canonicalDirectory: canonical,
            state,
            approvals,
            services,
          }) ??
          new ServerTurnRunner({
            canonicalDirectory: canonical,
            state,
            approvals,
            services,
          })
        const protocol = new SqliteSessionProtocolService({
          canonicalDirectory: canonical,
          workspaceId: `workspace-${digest}`,
          ownerId,
          state,
          runtime,
          runner,
          epochs,
          approvals: {
            deliver: (command) => approvals.deliver(command),
            onError: (error) => options.onDiagnostic?.(error),
          },
          onDiagnostic: options.onDiagnostic,
        })
        return new ManagedWorkspaceRuntime(canonical, {
          protocol,
          sessions: protocol,
          parallelAgents: services.parallelAgentManager,
          mcp: mcpClient,
          backgroundProcesses: services.backgroundProcesses,
          workspaceTasks: services.workspaceTasks,
          agentRuns: services,
          state: new RuntimeStateOwner(database, approvals),
        })
      } catch (error) {
        await closeNexusRunServices(services).catch(() => {})
        approvals.close()
        database.close()
        throw error
      }
    },
  }
}
