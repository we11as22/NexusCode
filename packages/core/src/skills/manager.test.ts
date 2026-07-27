import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  loadSkills,
  type SkillLoadDiagnostic,
} from "./manager.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{
  root: string
  cwd: string
  home: string
  diagnostics: SkillLoadDiagnostic[]
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-skills-"))
  roots.push(root)
  const cwd = path.join(root, "workspace")
  const home = path.join(root, "home")
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  return { root, cwd, home, diagnostics: [] }
}

describe("skill discovery", () => {
  it("gives the nearest project skill priority over a global skill with the same name", async () => {
    const { cwd, home, diagnostics } = await fixture()
    const projectSkill = path.join(cwd, ".nexus", "skills", "shared", "SKILL.md")
    const globalSkill = path.join(home, ".nexus", "skills", "shared", "SKILL.md")
    const globalOnly = path.join(home, ".nexus", "skills", "global-only", "SKILL.md")
    await mkdir(path.dirname(projectSkill), { recursive: true })
    await mkdir(path.dirname(globalSkill), { recursive: true })
    await mkdir(path.dirname(globalOnly), { recursive: true })
    await writeFile(projectSkill, "# Project guidance\nproject wins\n", "utf8")
    await writeFile(globalSkill, "# Global guidance\nglobal loses\n", "utf8")
    await writeFile(globalOnly, "# Global only\nloaded from configured home\n", "utf8")

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.filter((skill) => skill.name === "shared")).toHaveLength(1)
    expect(skills.find((skill) => skill.name === "shared")?.content)
      .toContain("project wins")
    expect(skills.find((skill) => skill.name === "global-only")?.content)
      .toContain("configured home")
    expect(diagnostics).toEqual([])
  })

  it("rejects oversized main files before reading them into the prompt", async () => {
    const { cwd, home, diagnostics } = await fixture()
    const skillPath = path.join(cwd, ".nexus", "skills", "huge", "SKILL.md")
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(skillPath, "x".repeat(80_001), "utf8")

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.some((skill) => skill.name === "huge")).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "skill-too-large",
        path: skillPath,
      }),
    ])
  })

  it("rejects malformed UTF-8 instead of expanding replacement characters past the byte bound", async () => {
    const { cwd, home, diagnostics } = await fixture()
    const skillPath = path.join(
      cwd,
      ".nexus",
      "skills",
      "invalid-utf8",
      "SKILL.md",
    )
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(skillPath, Buffer.alloc(80_000, 0xff))

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.some((skill) => skill.name === "invalid-utf8")).toBe(false)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill-read-failed",
        path: skillPath,
      }),
    )
  })

  it("preserves per-file and aggregate byte bounds for skill context", async () => {
    const { cwd, home, diagnostics } = await fixture()
    const skillDir = path.join(cwd, ".nexus", "skills", "bounded")
    const docsDir = path.join(skillDir, "docs")
    await mkdir(docsDir, { recursive: true })
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `# Bounded skill\n${"m".repeat(65_000)}\n`,
      "utf8",
    )
    await writeFile(
      path.join(docsDir, "a-small.md"),
      "SMALL_CONTEXT_ALLOWED\n",
      "utf8",
    )
    await writeFile(
      path.join(docsDir, "b-total-limit.md"),
      `TOTAL_LIMIT_SENTINEL\n${"t".repeat(15_000)}`,
      "utf8",
    )
    await writeFile(
      path.join(docsDir, "c-file-limit.md"),
      `FILE_LIMIT_SENTINEL\n${"f".repeat(20_001)}`,
      "utf8",
    )

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    const content = skills.find((skill) => skill.name === "bounded")?.content
    expect(content).toContain("SMALL_CONTEXT_ALLOWED")
    expect(content).not.toContain("TOTAL_LIMIT_SENTINEL")
    expect(content).not.toContain("FILE_LIMIT_SENTINEL")
    expect(diagnostics).toEqual([])
  })

  it("charges rendered context wrappers against the aggregate byte bound", async () => {
    const { cwd, home } = await fixture()
    const skillDir = path.join(cwd, ".nexus", "skills", "render-bounded")
    const docsDir = path.join(skillDir, "docs")
    await mkdir(docsDir, { recursive: true })
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `# Render bounded\n${"m".repeat(79_960)}\n`,
      "utf8",
    )
    await writeFile(path.join(docsDir, "a.md"), "x", "utf8")

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
    })

    const content = skills.find(
      (skill) => skill.name === "render-bounded",
    )?.content
    expect(content).toBeDefined()
    expect(Buffer.byteLength(content!, "utf8")).toBeLessThanOrEqual(80_000)
  })

  it("rejects symbolic-link skill files instead of following hidden instructions", async () => {
    const { root, cwd, home, diagnostics } = await fixture()
    const outside = path.join(root, "outside.md")
    const skillPath = path.join(cwd, ".nexus", "skills", "linked", "SKILL.md")
    await writeFile(outside, "# Hidden instructions\n", "utf8")
    await mkdir(path.dirname(skillPath), { recursive: true })
    await symlink(outside, skillPath)

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.some((skill) => skill.name === "linked")).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "skill-symlink",
        path: skillPath,
      }),
    ])
  })

  it("rejects a project skills root that is a symbolic link outside its authority", async () => {
    const { root, cwd, home, diagnostics } = await fixture()
    const outsideRoot = path.join(root, "outside-skills")
    const outsideSkill = path.join(outsideRoot, "escaped", "SKILL.md")
    const projectNexusDir = path.join(cwd, ".nexus")
    await mkdir(path.dirname(outsideSkill), { recursive: true })
    await writeFile(outsideSkill, "# Escaped instructions\nDO_NOT_LOAD\n", "utf8")
    await mkdir(projectNexusDir, { recursive: true })
    await symlink(outsideRoot, path.join(projectNexusDir, "skills"))

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.some((skill) => skill.content.includes("DO_NOT_LOAD"))).toBe(false)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill-symlink",
      }),
    )
  })

  it("rejects a nested symbolic-link skill directory", async () => {
    const { root, cwd, home, diagnostics } = await fixture()
    const outsideSkillDir = path.join(root, "outside-skill")
    const outsideSkill = path.join(outsideSkillDir, "SKILL.md")
    const skillsRoot = path.join(cwd, ".nexus", "skills")
    await mkdir(outsideSkillDir, { recursive: true })
    await writeFile(outsideSkill, "# Escaped instructions\nDO_NOT_LOAD\n", "utf8")
    await mkdir(skillsRoot, { recursive: true })
    await symlink(outsideSkillDir, path.join(skillsRoot, "escaped"))

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills.some((skill) => skill.content.includes("DO_NOT_LOAD"))).toBe(false)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill-symlink",
      }),
    )
  })

  it("allows only an explicitly configured absolute external root as its own authority", async () => {
    const { root, cwd, home, diagnostics } = await fixture()
    const externalRoot = path.join(root, "approved-external-skills")
    const skillPath = path.join(externalRoot, "approved", "SKILL.md")
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(skillPath, "# Approved instructions\nEXPLICITLY_ALLOWED\n", "utf8")

    const relativeSkills = await loadSkills(
      [path.relative(cwd, externalRoot)],
      cwd,
      undefined,
      undefined,
      undefined,
      {
        homeDirectory: home,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    )

    expect(relativeSkills.some((skill) => skill.name === "approved")).toBe(false)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill-symlink",
      }),
    )
    diagnostics.length = 0

    const skills = await loadSkills(
      [externalRoot],
      cwd,
      undefined,
      undefined,
      undefined,
      {
        homeDirectory: home,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    )

    expect(skills.find((skill) => skill.name === "approved")?.content)
      .toContain("EXPLICITLY_ALLOWED")
    expect(diagnostics).toEqual([])
  })

  it("rejects nested symlink escapes inside an explicit external authority", async () => {
    const { root, cwd, home, diagnostics } = await fixture()
    const externalRoot = path.join(root, "approved-external-skills")
    const outsideSkillDir = path.join(root, "outside-explicit-authority")
    await mkdir(externalRoot, { recursive: true })
    await mkdir(outsideSkillDir, { recursive: true })
    await writeFile(
      path.join(outsideSkillDir, "SKILL.md"),
      "# Escaped explicit instructions\nDO_NOT_LOAD_EXPLICIT_ESCAPE\n",
      "utf8",
    )
    await symlink(outsideSkillDir, path.join(externalRoot, "escaped"))

    const skills = await loadSkills(
      [externalRoot],
      cwd,
      undefined,
      undefined,
      undefined,
      {
        homeDirectory: home,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    )

    expect(
      skills.some((skill) =>
        skill.content.includes("DO_NOT_LOAD_EXPLICIT_ESCAPE"),
      ),
    ).toBe(false)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill-symlink",
      }),
    )
  })

  it("reports malformed frontmatter and spec-invalid name mismatches", async () => {
    const { cwd, home, diagnostics } = await fixture()
    const malformed = path.join(cwd, ".nexus", "skills", "broken", "SKILL.md")
    const mismatch = path.join(cwd, ".nexus", "skills", "expected", "SKILL.md")
    await mkdir(path.dirname(malformed), { recursive: true })
    await mkdir(path.dirname(mismatch), { recursive: true })
    await writeFile(malformed, "---\nname: [broken\n---\nbody\n", "utf8")
    await writeFile(
      mismatch,
      "---\nname: different\ndescription: Example\n---\nbody\n",
      "utf8",
    )

    const skills = await loadSkills([], cwd, undefined, undefined, undefined, {
      homeDirectory: home,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })

    expect(skills).toEqual([])
    expect(diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      "skill-frontmatter-invalid",
      "skill-name-mismatch",
    ])
  })
})
