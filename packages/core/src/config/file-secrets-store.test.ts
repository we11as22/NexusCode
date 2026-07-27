import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createFileSecretsStore,
  persistSecretsFromConfig,
  SecretsCorruptionError,
} from "./secrets.js"

describe("CLI file secrets store", () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("fails closed instead of overwriting a corrupt credential store", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-file-secrets-"))
    const path = join(directory, "secrets.json")
    await writeFile(path, "{corrupt")
    const store = createFileSecretsStore(directory)

    await expect(store.getSecret("model")).rejects.toThrow(
      /Failed to read secrets/,
    )
    await expect(store.setSecret("model", "replacement")).rejects.toThrow(
      /Failed to read secrets/,
    )
    await expect(readFile(path, "utf8")).resolves.toBe("{corrupt")
  })

  it("writes atomically with owner-only permissions and preserves other keys", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-file-secrets-"))
    const store = createFileSecretsStore(directory)

    await store.setSecret("model", "model-secret")
    await store.setSecret("server", "server-secret")

    await expect(store.getSecret("model")).resolves.toBe("model-secret")
    await expect(store.getSecret("server")).resolves.toBe("server-secret")
    const mode = (await stat(join(directory, "secrets.json"))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("serializes payload updates across independent file-store instances", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-file-secrets-rmw-"))
    const first = createFileSecretsStore(directory)
    const second = createFileSecretsStore(directory)

    await Promise.all([
      persistSecretsFromConfig({
        model: {
          provider: "openai",
          id: "gpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "openai-secret",
        },
      }, first),
      persistSecretsFromConfig({
        model: {
          provider: "groq",
          id: "llama",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "groq-secret",
        },
      }, second),
    ])

    const outer = JSON.parse(
      await readFile(join(directory, "secrets.json"), "utf8"),
    ) as Record<string, string>
    const payload = JSON.parse(outer["nexuscode_api"] ?? "{}") as {
      credentials: Record<string, { secret: string }>
    }
    expect(
      Object.values(payload.credentials).map((entry) => entry.secret).sort(),
    ).toEqual(["groq-secret", "openai-secret"])
  })

  it("quarantines a corrupt inner payload without changing outer file bytes", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-file-secrets-inner-"))
    const path = join(directory, "secrets.json")
    const original = `${JSON.stringify({
      nexuscode_api: "{\"version\":2,\"credentials\":",
      unrelated: "preserve-me",
    }, null, 2)}\n`
    await writeFile(path, original, { mode: 0o600 })
    const store = createFileSecretsStore(directory)

    await expect(persistSecretsFromConfig({
      model: {
        provider: "openai",
        id: "gpt",
        apiKey: "replacement",
      },
    }, store)).rejects.toBeInstanceOf(SecretsCorruptionError)
    await expect(readFile(path, "utf8")).resolves.toBe(original)
  })

  it("refuses a symbolic-link credential store without touching its target", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-file-secrets-link-"))
    const target = join(directory, "external-target.json")
    const path = join(directory, "secrets.json")
    const original = "{\"preserve\":\"target\"}\n"
    await writeFile(target, original)
    await symlink(target, path)
    const store = createFileSecretsStore(directory)

    await expect(store.setSecret("model", "replacement")).rejects.toThrow(
      /symbolic-link credential store/,
    )
    await expect(readFile(target, "utf8")).resolves.toBe(original)
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })
})
