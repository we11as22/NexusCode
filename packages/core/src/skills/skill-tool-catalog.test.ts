import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { NexusConfig } from "../types.js"
import {
  resolveSkillBody,
  sampleSkillSiblingFiles,
} from "./skill-tool-catalog.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function catalogFixture(): Promise<{
  cwd: string
  home: string
  config: NexusConfig
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-skill-catalog-"))
  roots.push(root)
  const cwd = path.join(root, "workspace")
  const home = path.join(root, "home")
  const skillRoot = path.join(root, "configured-skills")
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })

  for (const name of ["foo", "foo-bar", "foo-baz"]) {
    const skillPath = path.join(skillRoot, name, "SKILL.md")
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(
      skillPath,
      `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
      "utf8",
    )
  }

  return {
    cwd,
    home,
    config: { skills: [skillRoot] } as NexusConfig,
  }
}

describe("skill tool catalog resolution", () => {
  it("prefers exact and normalized-exact matches over partial matches", async () => {
    const { cwd, home, config } = await catalogFixture()

    await expect(
      resolveSkillBody("foo", cwd, config, { homeDirectory: home }),
    ).resolves.toMatchObject({ displayName: "foo" })
    await expect(
      resolveSkillBody("FOO BAR", cwd, config, { homeDirectory: home }),
    ).resolves.toMatchObject({ displayName: "foo-bar" })
  })

  it("reports deterministic candidates instead of choosing an arbitrary partial collision", async () => {
    const { cwd, home, config } = await catalogFixture()

    await expect(
      resolveSkillBody("foo-b", cwd, config, { homeDirectory: home }),
    ).rejects.toMatchObject({
      name: "SkillNameAmbiguityError",
      candidates: ["foo-bar", "foo-baz"],
    })
  })
})

describe("skill sibling sampling", () => {
  it("still samples regular sibling files deterministically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-skill-sample-"))
    roots.push(root)
    const skillDir = path.join(root, "skill")
    await mkdir(path.join(skillDir, "docs"), { recursive: true })
    await writeFile(path.join(skillDir, "SKILL.md"), "# Main\n", "utf8")
    await writeFile(path.join(skillDir, "docs", "b.txt"), "b", "utf8")
    await writeFile(path.join(skillDir, "docs", "a.txt"), "a", "utf8")
    const authority = {
      lexicalRoot: skillDir,
      realRoot: await realpath(skillDir),
    }

    const files = await sampleSkillSiblingFiles(
      skillDir,
      undefined,
      authority,
    )

    expect(files).toEqual([
      path.join(skillDir, "docs", "a.txt"),
      path.join(skillDir, "docs", "b.txt"),
    ])
  })

  it("does not enumerate through a parent symlink outside the captured authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-skill-sample-"))
    roots.push(root)
    const workspace = path.join(root, "workspace")
    const externalSkills = path.join(root, "external-skills")
    const externalSkill = path.join(externalSkills, "escaped")
    await mkdir(path.join(workspace, ".nexus"), { recursive: true })
    await mkdir(externalSkill, { recursive: true })
    await writeFile(
      path.join(externalSkill, "outside-secret.txt"),
      "do not advertise",
      "utf8",
    )
    const authority = {
      lexicalRoot: workspace,
      realRoot: await realpath(workspace),
    }
    await symlink(
      externalSkills,
      path.join(workspace, ".nexus", "skills"),
    )

    const files = await sampleSkillSiblingFiles(
      path.join(workspace, ".nexus", "skills", "escaped"),
      undefined,
      authority,
    )

    expect(files).toEqual([])
  })
})
