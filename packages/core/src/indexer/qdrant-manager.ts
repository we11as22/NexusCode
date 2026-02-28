import * as os from "node:os"
import * as path from "node:path"
import { mkdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import { execa } from "execa"

const DEFAULT_HEALTH_TIMEOUT_MS = 1_500
const DEFAULT_START_TIMEOUT_MS = 20_000

export interface EnsureQdrantOptions {
  url: string
  autoStart: boolean
  log?: (message: string) => void
}

export interface EnsureQdrantResult {
  available: boolean
  started: boolean
  method?: "existing" | "binary" | "docker"
  warning?: string
}

/**
 * Ensures Qdrant is reachable. If autoStart is enabled, tries to start a local instance.
 */
export async function ensureQdrantRunning(opts: EnsureQdrantOptions): Promise<EnsureQdrantResult> {
  const { url, autoStart, log } = opts

  if (await isQdrantHealthy(url)) {
    return { available: true, started: false, method: "existing" }
  }

  if (!autoStart) {
    return {
      available: false,
      started: false,
      warning: `Qdrant is not reachable at ${url}. Enable vectorDb.autoStart or start Qdrant manually.`,
    }
  }

  const parsed = safeParseUrl(url)
  if (!parsed) {
    return {
      available: false,
      started: false,
      warning: `Invalid vectorDb.url: ${url}`,
    }
  }

  const host = parsed.hostname
  const port = Number(parsed.port || "6333")
  if (!isLocalHost(host)) {
    return {
      available: false,
      started: false,
      warning: `vectorDb.autoStart only supports localhost URLs, got: ${url}`,
    }
  }

  // 1) Try local qdrant binary
  if (await tryStartLocalBinary(port, log)) {
    if (await waitForHealthy(url, DEFAULT_START_TIMEOUT_MS)) {
      return { available: true, started: true, method: "binary" }
    }
  }

  // 2) Try docker fallback
  if (await tryStartDocker(port, log)) {
    if (await waitForHealthy(url, DEFAULT_START_TIMEOUT_MS)) {
      return { available: true, started: true, method: "docker" }
    }
  }

  return {
    available: false,
    started: false,
    warning: `Failed to auto-start Qdrant for ${url}. Install local qdrant binary or run container manually.`,
  }
}

async function isQdrantHealthy(baseUrl: string, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(joinUrl(baseUrl, "/collections"), {
      signal: controller.signal as any,
      headers: { Accept: "application/json" },
    })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isQdrantHealthy(baseUrl, 1_000)) return true
    await sleep(500)
  }
  return false
}

async function tryStartLocalBinary(port: number, log?: (message: string) => void): Promise<boolean> {
  if (!(await commandExists("qdrant"))) {
    return false
  }

  try {
    const storagePath = path.join(os.homedir(), ".nexus", "qdrant", "storage")
    await mkdir(storagePath, { recursive: true })

    const child = spawn("qdrant", [], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: "127.0.0.1",
        QDRANT__SERVICE__HTTP_PORT: String(port),
        QDRANT__STORAGE__STORAGE_PATH: storagePath,
      },
    })
    child.unref()
    log?.(`[nexus] Qdrant: started local binary on port ${port}`)
    return true
  } catch {
    return false
  }
}

async function tryStartDocker(port: number, log?: (message: string) => void): Promise<boolean> {
  if (!(await commandExists("docker"))) {
    return false
  }

  const containerName = `nexus-qdrant-${port}`
  try {
    const running = await execa("docker", ["inspect", "-f", "{{.State.Running}}", containerName], {
      reject: false,
    })

    if ((running.stdout ?? "").trim() === "true") {
      log?.(`[nexus] Qdrant: docker container ${containerName} is already running`)
      return true
    }

    if (running.exitCode === 0) {
      const started = await execa("docker", ["start", containerName], { reject: false })
      if (started.exitCode === 0) {
        log?.(`[nexus] Qdrant: started docker container ${containerName}`)
        return true
      }
    }

    const storagePath = path.join(os.homedir(), ".nexus", "qdrant", "docker-storage")
    await mkdir(storagePath, { recursive: true })

    const result = await execa(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerName,
        "-p",
        `127.0.0.1:${port}:6333`,
        "-v",
        `${storagePath}:/qdrant/storage`,
        "qdrant/qdrant",
      ],
      { reject: false }
    )

    if (result.exitCode === 0) {
      log?.(`[nexus] Qdrant: launched docker container ${containerName} on port ${port}`)
      return true
    }
  } catch {
    return false
  }

  return false
}

async function commandExists(cmd: string): Promise<boolean> {
  const result = await execa("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], {
    reject: false,
  })
  return result.exitCode === 0
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
