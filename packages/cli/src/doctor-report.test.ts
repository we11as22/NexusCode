import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { collectDoctorReport } from "./doctor-report.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe("headless CLI doctor", () => {
  it("reports runtime, workspace, config, and optional command capabilities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-doctor-"))
    roots.push(root)
    const commandVersion = vi.fn(async (command: string) => command === "git")
    const ripgrepStatus = vi.fn(async () => ({
      available: true,
      source: "bundled" as const,
      version: "ripgrep 14.1.1",
    }))

    const report = await collectDoctorReport(root, {
      runtimeVersion: "24.18.0",
      loadConfig: vi.fn(async () => ({
        model: { provider: "openai-compatible", id: "model:free" },
      })),
      commandVersion,
      ripgrepStatus,
      sandboxStatus: vi.fn(async () => ({
        available: true,
        target: "darwin-arm64",
        version: "nexus-sandbox 0.1.0 protocol=1",
      })),
    })

    expect(report.ok).toBe(true)
    expect(report.lines.join("\n")).toContain("✓ Model openai-compatible/model:free")
    expect(report.lines.join("\n")).toContain("✓ Git available")
    expect(report.lines.join("\n")).toContain(
      "✓ ripgrep 14.1.1 (bundled)",
    )
    expect(commandVersion).toHaveBeenCalledTimes(1)
    expect(ripgrepStatus).toHaveBeenCalledTimes(1)
    expect(report.lines.join("\n")).toContain(
      "✓ OS sandbox darwin-arm64",
    )
  })

  it("fails clearly on an unpinned runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-doctor-runtime-"))
    roots.push(root)

    const report = await collectDoctorReport(root, {
      runtimeVersion: "20.19.2",
      loadConfig: vi.fn(async () => ({
        model: { provider: "openai-compatible", id: "model:free" },
      })),
      commandVersion: vi.fn(async () => true),
      sandboxStatus: vi.fn(async () => ({
        available: true,
        target: "darwin-arm64",
      })),
    })

    expect(report.ok).toBe(false)
    expect(report.lines.join("\n")).toContain(
      "✗ Node 20.19.2; required 24.18.0",
    )
  })

  it("fails closed when the native sandbox helper is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-doctor-sandbox-"))
    roots.push(root)

    const report = await collectDoctorReport(root, {
      runtimeVersion: "24.18.0",
      loadConfig: vi.fn(async () => ({
        model: { provider: "openai-compatible", id: "model:free" },
      })),
      commandVersion: vi.fn(async () => true),
      ripgrepStatus: vi.fn(async () => ({
        available: true,
        source: "bundled" as const,
      })),
      sandboxStatus: vi.fn(async () => ({
        available: false,
        target: "linux-x64",
        error: "helper missing",
      })),
    })

    expect(report.ok).toBe(false)
    expect(report.lines.join("\n")).toContain(
      "✗ OS sandbox linux-x64 unavailable: helper missing",
    )
  })
})
