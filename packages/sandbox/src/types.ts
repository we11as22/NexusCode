export const NEXUS_SANDBOX_PROTOCOL_VERSION = 1 as const

export type SandboxNetworkPolicy = "restricted" | "enabled"
export type SandboxProfile = "read-only" | "workspace-write"
export type SandboxKind =
  | "seatbelt"
  | "bwrap-seccomp"
  | "windows-restricted-token"
  | "none"

export interface NativeSandboxRequest {
  version: typeof NEXUS_SANDBOX_PROTOCOL_VERSION
  executionId: string
  argv: string[]
  cwd: string
  readableRoots: string[]
  writableRoots: string[]
  readOnlyRoots: string[]
  deniedRoots?: string[]
  network: SandboxNetworkPolicy
  timeoutMillis: number
  inheritEnv: boolean
  environment?: Record<string, string>
  allowUnixSockets?: string[]
}

export interface CreateSandboxRequestInput {
  executionId: string
  command: string
  cwd: string
  workspaceRoots: string[]
  /** Trusted installed runtime paths that stay immutable inside broad workspaces. */
  protectedRoots?: string[]
  profile: SandboxProfile
  network?: SandboxNetworkPolicy
  timeoutMs?: number
  platform?: NodeJS.Platform
  windowsComSpec?: string
  /** Host-created private temporary directory owned by this execution. */
  tempDir: string
  environment?: Record<string, string>
  allowUnixSockets?: string[]
}

export interface SandboxExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  sandbox: SandboxKind
  timedOut: boolean
  denied: boolean
  setupError?: {
    code: string
    message: string
  }
}
