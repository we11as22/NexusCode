import type {
  WorkspaceOwnedService,
  WorkspaceRuntime,
  WorkspaceRuntimeServices,
} from "./types.js"

function lifecycleService(value: unknown): WorkspaceOwnedService | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined
  }
  const candidate = value as WorkspaceOwnedService
  return typeof candidate.shutdown === "function" ||
    typeof candidate.close === "function" ||
    typeof candidate.dispose === "function"
    ? candidate
    : undefined
}

async function closeService(service: WorkspaceOwnedService): Promise<void> {
  if (typeof service.shutdown === "function") {
    await service.shutdown()
    return
  }
  if (typeof service.close === "function") {
    await service.close()
    return
  }
  await service.dispose?.()
}

const INTEGRATION_SHUTDOWN_ORDER = [
  "plugins",
  "mcp",
  "memory",
  "index",
] as const

export class ManagedWorkspaceRuntime implements WorkspaceRuntime {
  readonly canonicalDirectory: string
  readonly services: Readonly<WorkspaceRuntimeServices>
  readonly #closedServices = new Set<WorkspaceOwnedService>()
  #closePromise: Promise<void> | undefined
  #closed = false

  constructor(
    canonicalDirectory: string,
    services: WorkspaceRuntimeServices,
  ) {
    this.canonicalDirectory = canonicalDirectory
    this.services = Object.freeze({ ...services })
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise

    const closeAttempt = (async () => {
      const protocolService = lifecycleService(this.services.protocol)
      const sessionService = lifecycleService(this.services.sessions)
      const parallelService = lifecycleService(this.services.parallelAgents)
      const workspaceTaskService = lifecycleService(
        this.services.workspaceTasks,
      )
      const stateService = lifecycleService(this.services.state)

      // Dependency barriers: close ingress before draining sessions, then
      // fence delegated work before integrations or durable state disappear.
      await this.#closeBarrier(protocolService)
      await this.#closeBarrier(sessionService)
      await this.#closeBarrier(parallelService)
      await this.#closeBarrier(workspaceTaskService)

      const explicitlyOrderedNames = new Set<string>([
        "protocol",
        "sessions",
        "parallelAgents",
        "workspaceTasks",
        ...INTEGRATION_SHUTDOWN_ORDER,
        "state",
      ])
      const services = [
        ...INTEGRATION_SHUTDOWN_ORDER.map((name) => this.services[name]),
        ...Object.entries(this.services)
          .filter(([name]) => !explicitlyOrderedNames.has(name))
          .map(([, service]) => service),
      ]
      const errors: unknown[] = []
      const seen = new Set<WorkspaceOwnedService>()
      for (const service of [
        protocolService,
        sessionService,
        parallelService,
        workspaceTaskService,
        stateService,
      ]) {
        if (service) seen.add(service)
      }

      for (const value of services) {
        const service = lifecycleService(value)
        if (!service || seen.has(service)) continue
        seen.add(service)
        if (this.#closedServices.has(service)) continue
        try {
          await closeService(service)
          this.#closedServices.add(service)
        } catch (error) {
          errors.push(error)
        }
      }

      if (errors.length > 0) {
        if (errors.length === 1) throw errors[0]
        throw new AggregateError(
          errors,
          `Failed to close workspace runtime ${this.canonicalDirectory}`,
        )
      }

      if (
        stateService &&
        !this.#closedServices.has(stateService)
      ) {
        await closeService(stateService)
        this.#closedServices.add(stateService)
      }

      this.#closed = true
    })()
    this.#closePromise = closeAttempt.catch((error) => {
      if (!this.#closed) this.#closePromise = undefined
      throw error
    })

    return this.#closePromise
  }

  async #closeBarrier(
    service: WorkspaceOwnedService | undefined,
  ): Promise<void> {
    if (!service || this.#closedServices.has(service)) return
    await closeService(service)
    this.#closedServices.add(service)
  }
}
