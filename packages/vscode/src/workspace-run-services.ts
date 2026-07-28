import {
  canonicalProjectRoot,
  closeNexusRunServices,
  createNexusRunServices,
  FileChangeSetStore,
  getGlobalConfigDir,
  GitService,
  hashWorkspaceIdentity,
  OrchestrationRuntime,
  scheduleToolOutputMaintenance,
  type NexusRunServices,
} from "@nexuscode/core"

/**
 * Owns live local-agent services by canonical VS Code workspace.
 *
 * Durable state is stored elsewhere; this registry deliberately owns only
 * process-local handles that must survive from one chat turn to the next.
 */
export class WorkspaceRunServicesRegistry {
  readonly #services = new Map<string, NexusRunServices>()
  #closePromise: Promise<void> | undefined
  #closed = false

  get(directory: string): NexusRunServices {
    if (this.#closed || this.#closePromise) {
      throw new Error("Workspace run services registry is closed.")
    }
    const canonicalDirectory = canonicalProjectRoot(directory)
    const existing = this.#services.get(canonicalDirectory)
    if (existing) return existing
    const workspaceId = hashWorkspaceIdentity(canonicalDirectory)
    const created = createNexusRunServices({
      orchestrationRuntime: new OrchestrationRuntime(canonicalDirectory),
      changeSets: {
        workspaceId,
        store: new FileChangeSetStore(workspaceId, {
          rootDir: getGlobalConfigDir(),
        }),
      },
      git: new GitService(canonicalDirectory),
    })
    const toolOutputMaintenance = scheduleToolOutputMaintenance({
      cwd: canonicalDirectory,
      services: created,
      onResult(result) {
        for (const diagnostic of result.errors) {
          console.warn(`[nexus] tool-output maintenance: ${diagnostic}`)
        }
      },
    })
    void toolOutputMaintenance?.promise.catch((error) => {
      console.warn("[nexus] tool-output maintenance failed:", error)
    })
    this.#services.set(canonicalDirectory, created)
    return created
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    const ownedServices = [...this.#services.values()]
    this.#services.clear()
    this.#closePromise = (async () => {
      const outcomes = await Promise.allSettled(
        ownedServices.map((services) => closeNexusRunServices(services)),
      )
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      )
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Failed to close VS Code workspace run services",
        )
      }
    })()
    return this.#closePromise
  }
}
