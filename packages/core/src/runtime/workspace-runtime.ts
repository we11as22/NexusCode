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

    this.#closePromise = (async () => {
      const errors: unknown[] = []
      const seen = new Set<WorkspaceOwnedService>()
      const explicitlyOrderedNames = new Set<string>([
        "parallelAgents",
        ...INTEGRATION_SHUTDOWN_ORDER,
        "state",
      ])
      const services = [
        this.services.parallelAgents,
        ...INTEGRATION_SHUTDOWN_ORDER.map((name) => this.services[name]),
        ...Object.entries(this.services)
          .filter(([name]) => !explicitlyOrderedNames.has(name))
          .map(([, service]) => service),
        this.services.state,
      ]
      for (const value of services) {
        const service = lifecycleService(value)
        if (!service || seen.has(service)) continue
        seen.add(service)
        try {
          await closeService(service)
        } catch (error) {
          errors.push(error)
        }
      }
      this.#closed = true
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `Failed to close workspace runtime ${this.canonicalDirectory}`,
        )
      }
    })()

    return this.#closePromise
  }
}
