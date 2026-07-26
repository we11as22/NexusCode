import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))

test("core runtime does not require an unused native SQLite addon", async () => {
  const corePackage = await readJson("packages/core/package.json")
  const rootPackage = await readJson("package.json")
  const workspace = await readFile("pnpm-workspace.yaml", "utf8")

  assert.equal(corePackage.dependencies?.["better-sqlite3"], undefined)
  assert.equal(corePackage.devDependencies?.["@types/better-sqlite3"], undefined)
  assert.equal(rootPackage.scripts?.["doctor:native"], undefined)
  assert.equal(rootPackage.scripts?.["setup:native"], undefined)
  assert.equal(rootPackage.scripts?.["rebuild:native"], undefined)
  assert.doesNotMatch(rootPackage.scripts?.setup ?? "", /native/)
  assert.doesNotMatch(workspace, /better-sqlite3/)
})
