export interface WorkspaceOwnedService {
  shutdown?(): void | Promise<void>
  close?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface WorkspaceRuntimeServices {
  parallelAgents?: WorkspaceOwnedService
  mcp?: WorkspaceOwnedService
  plugins?: WorkspaceOwnedService
  memory?: WorkspaceOwnedService
  index?: WorkspaceOwnedService
  state?: WorkspaceOwnedService
  [name: string]: unknown
}

export interface WorkspaceRuntime {
  readonly canonicalDirectory: string
  readonly services: Readonly<WorkspaceRuntimeServices>
  readonly closed: boolean
  close(): Promise<void>
}

export interface WorkspaceRuntimeFactory {
  create(canonicalDirectory: string): Promise<WorkspaceRuntime>
}

export interface WorkspaceRuntimeHandle {
  readonly canonicalDirectory: string
  readonly runtime: WorkspaceRuntime
  readonly released: boolean
  release(): Promise<void>
}
