import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { expandInstructionIncludes } from "./instruction-include.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("instruction includes", () => {
  it("allows nested files under the authority root and blocks traversal or absolute escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-includes-"))
    roots.push(root)
    const rules = path.join(root, "rules")
    await mkdir(path.join(rules, "nested"), { recursive: true })
    const outside = path.join(root, "secret.md")
    await writeFile(path.join(rules, "nested", "ok.md"), "SAFE_INCLUDE", "utf8")
    await writeFile(outside, "OUTSIDE_SECRET", "utf8")

    const expanded = await expandInstructionIncludes(
      `@nested/ok.md\n@../secret.md\n@${outside}`,
      rules,
      new Set(),
    )

    expect(expanded).toContain("SAFE_INCLUDE")
    expect(expanded).not.toContain("OUTSIDE_SECRET")
    expect(expanded.match(/blocked include outside approved root/g)).toHaveLength(2)
  })

  it("does not interpret include-looking lines inside fenced code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-includes-"))
    roots.push(root)
    await writeFile(path.join(root, "other.md"), "EXPANDED", "utf8")
    const expanded = await expandInstructionIncludes(
      "```\n@other.md\n```",
      root,
      new Set(),
    )
    expect(expanded).toBe("```\n@other.md\n```")
  })
})
