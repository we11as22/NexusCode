import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const roots: string[] = []

async function loadConfigFor(directory: string) {
  vi.resetModules()
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("NEXUS_CONFIG_DIR", directory)
  const module = await import("./config.js")
  module.enableConfigs()
  return module
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe("CLI presentation state first-run persistence", () => {
  it("creates an owner-only config directory and state file on first mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-cli-first-run-"))
    roots.push(root)
    const configDir = path.join(root, "missing", ".nexus")
    const config = await loadConfigFor(configDir)

    config.saveGlobalConfig({
      ...config.DEFAULT_GLOBAL_CONFIG,
      hasCompletedOnboarding: true,
    })

    const statePath = path.join(configDir, "config.json")
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      hasCompletedOnboarding: true,
    })
    if (process.platform !== "win32") {
      expect((await stat(configDir)).mode & 0o777).toBe(0o700)
      expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    }
  })

  it("removes legacy plaintext credentials whenever state is rewritten", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-cli-secret-migration-"))
    roots.push(root)
    const configDir = path.join(root, ".nexus")
    const config = await loadConfigFor(configDir)

    config.saveGlobalConfig({
      ...config.DEFAULT_GLOBAL_CONFIG,
      hasCompletedOnboarding: true,
      primaryApiKey: "must-not-be-persisted",
    })

    const persisted = JSON.parse(
      await readFile(path.join(configDir, "config.json"), "utf8"),
    ) as Record<string, unknown>
    expect(persisted.primaryApiKey).toBeUndefined()
    expect(JSON.stringify(persisted)).not.toContain("must-not-be-persisted")
  })

  it("does not advertise the retired plaintext credential as a CLI config key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-cli-config-keys-"))
    roots.push(root)
    const config = await loadConfigFor(path.join(root, ".nexus"))

    expect(config.isGlobalConfigKey("primaryApiKey")).toBe(false)
    expect(config.GLOBAL_CONFIG_KEYS).not.toContain("primaryApiKey")
  })

  it("refuses to overwrite a symlinked state file", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "nexus-cli-symlink-"))
    roots.push(root)
    const configDir = path.join(root, ".nexus")
    const outside = path.join(root, "outside.json")
    await mkdir(configDir, { recursive: true })
    await writeFile(outside, "{}")
    await symlink(outside, path.join(configDir, "config.json"))
    const config = await loadConfigFor(configDir)

    expect(() =>
      config.saveGlobalConfig({
        ...config.DEFAULT_GLOBAL_CONFIG,
        hasCompletedOnboarding: true,
      }),
    ).toThrow(/symbolic link/i)
    expect((await lstat(path.join(configDir, "config.json"))).isSymbolicLink()).toBe(
      true,
    )
    expect(await readFile(outside, "utf8")).toBe("{}")
  })
})
