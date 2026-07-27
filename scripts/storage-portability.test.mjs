import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { promisify } from "node:util"

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))
const execFileAsync = promisify(execFile)

test("managed runtime uses built-in SQLite without an external native addon", async () => {
  const corePackage = await readJson("packages/core/package.json")
  const rootPackage = await readJson("package.json")
  const workspace = await readFile("pnpm-workspace.yaml", "utf8")

  assert.equal(corePackage.dependencies?.["better-sqlite3"], undefined)
  assert.equal(corePackage.dependencies?.sqlite3, undefined)
  assert.equal(corePackage.devDependencies?.["@types/better-sqlite3"], undefined)
  assert.equal(rootPackage.scripts?.["doctor:native"], undefined)
  assert.equal(rootPackage.scripts?.["setup:native"], undefined)
  assert.equal(rootPackage.scripts?.["rebuild:native"], undefined)
  assert.doesNotMatch(rootPackage.scripts?.setup ?? "", /native/)
  assert.doesNotMatch(workspace, /better-sqlite3/)
  assert.doesNotMatch(workspace, /(?:^|[\s/])sqlite3(?:@|[\s:])/m)
})

test("node:sqlite stays behind the state driver boundary", async () => {
  const stateSources = [
    "database.ts",
    "index.ts",
    "migrations.ts",
    "schema.ts",
    "sqlite-driver.ts",
  ]
  const contents = await Promise.all(
    stateSources.map(async (file) => ({
      file,
      source: await readFile(`packages/state/src/${file}`, "utf8"),
    })),
  )

  const driver = contents.find(({ file }) => file === "sqlite-driver.ts")
  assert.match(driver.source, /from "node:sqlite"/)
  for (const { file, source } of contents) {
    if (file === "sqlite-driver.ts") continue
    assert.doesNotMatch(source, /node:sqlite/, `${file} bypasses the driver boundary`)
  }
})

test("workspace does not track machine-specific dependency links", async () => {
  const { stdout } = await execFileAsync("git", [
    "ls-files",
    "--",
    ":(glob)**/node_modules/**",
  ])

  assert.equal(
    stdout.trim(),
    "",
    `Tracked node_modules entries make clean installs machine-specific:\n${stdout}`,
  )
})
