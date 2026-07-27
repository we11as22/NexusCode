import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  WebviewPathCapabilityError,
  WebviewPathCapabilities,
} from "./webview-path-capabilities.js"

const tempDirectories: string[] = []

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-webview-path-"),
  )
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("WebviewPathCapabilities", () => {
  it("confines editor actions to canonical workspace descendants", () => {
    const root = makeTempDirectory()
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside.txt")
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
    fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export {}")
    fs.writeFileSync(outside, "secret")
    const capabilities = new WebviewPathCapabilities()

    expect(
      capabilities.resolveWorkspacePath(workspace, "src/index.ts"),
    ).toBe(fs.realpathSync.native(path.join(workspace, "src", "index.ts")))
    expect(() =>
      capabilities.resolveWorkspacePath(workspace, outside),
    ).toThrow(WebviewPathCapabilityError)
  })

  it("opens only skill files that the host most recently advertised", () => {
    const root = makeTempDirectory()
    const known = path.join(root, "known", "SKILL.md")
    const unknown = path.join(root, "unknown", "SKILL.md")
    fs.mkdirSync(path.dirname(known), { recursive: true })
    fs.mkdirSync(path.dirname(unknown), { recursive: true })
    fs.writeFileSync(known, "# Known")
    fs.writeFileSync(unknown, "# Unknown")
    const capabilities = new WebviewPathCapabilities()

    capabilities.replaceKnownSkillPaths([known])

    expect(capabilities.resolveKnownSkillPath(known)).toBe(
      fs.realpathSync.native(known),
    )
    expect(() =>
      capabilities.resolveKnownSkillPath(unknown),
    ).toThrow(WebviewPathCapabilityError)
  })

  it("does not grant directory capabilities as skill definitions", () => {
    const root = makeTempDirectory()
    const skillDirectory = path.join(root, "skill")
    fs.mkdirSync(skillDirectory)
    const capabilities = new WebviewPathCapabilities()

    capabilities.replaceKnownSkillPaths([skillDirectory])

    expect(() =>
      capabilities.resolveKnownSkillPath(skillDirectory),
    ).toThrow(WebviewPathCapabilityError)
  })

  it("invalidates a skill capability if a symlink is retargeted", () => {
    const root = makeTempDirectory()
    const first = path.join(root, "first.md")
    const second = path.join(root, "second.md")
    const link = path.join(root, "skill.md")
    fs.writeFileSync(first, "# First")
    fs.writeFileSync(second, "# Second")
    fs.symlinkSync(first, link)
    const capabilities = new WebviewPathCapabilities()
    capabilities.replaceKnownSkillPaths([link])

    fs.unlinkSync(link)
    fs.symlinkSync(second, link)

    expect(() =>
      capabilities.resolveKnownSkillPath(link),
    ).toThrow(/changed|capability/i)
  })

  it("revokes skills omitted from the next host snapshot", () => {
    const root = makeTempDirectory()
    const skill = path.join(root, "SKILL.md")
    fs.writeFileSync(skill, "# Skill")
    const capabilities = new WebviewPathCapabilities()
    capabilities.replaceKnownSkillPaths([skill])
    capabilities.replaceKnownSkillPaths([])

    expect(() =>
      capabilities.resolveKnownSkillPath(skill),
    ).toThrow(WebviewPathCapabilityError)
  })
})
