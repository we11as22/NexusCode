import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

function packageJson(path) {
  return JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"))
}

test("workspace consumers do not rebuild the shared sandbox concurrently", () => {
  const consumers = [
    packageJson("../packages/cli/package.json"),
    packageJson("../packages/server/package.json"),
    packageJson("../packages/vscode/package.json"),
  ]

  for (const consumer of consumers) {
    for (const command of Object.values(consumer.scripts ?? {})) {
      assert.doesNotMatch(
        command,
        /--filter\s+@nexuscode\/sandbox\s+build/,
        `${consumer.name} must rely on the workspace dependency graph`,
      )
    }
  }
})

test("targeted root builds include workspace dependencies", () => {
  const root = packageJson("../package.json")

  assert.match(root.scripts["build:cli"], /--filter\s+@nexuscode\/cli\.\.\.\s+build/)
  assert.match(
    root.scripts["build:server"],
    /--filter\s+@nexuscode\/server\.\.\.\s+build/,
  )
  assert.match(root.scripts["build:vscode"], /--filter\s+nexuscode\.\.\.\s+build/)
})
