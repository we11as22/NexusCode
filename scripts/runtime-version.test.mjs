import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  assertBuiltinSqlite,
  validateRuntimeVersion,
} from "./runtime-version.mjs"

test("accepts the pinned Node release", () => {
  assert.deepEqual(validateRuntimeVersion("24.18.0"), { ok: true })
})

test("the pinned runtime exposes built-in SQLite", async () => {
  const sqlite = await import("node:sqlite")
  assert.equal(typeof sqlite.DatabaseSync, "function")
  assert.equal(await assertBuiltinSqlite(), true)
})

test("build and installer surfaces target the pinned Node 24 runtime", async () => {
  const [cliBuild, vscodeBuild, installer, oneInstall, vsixPackager] = await Promise.all([
    readFile(new URL("../packages/cli/tsup.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/vscode/esbuild.mjs", import.meta.url), "utf8"),
    readFile(new URL("./install-nexus-cli.sh", import.meta.url), "utf8"),
    readFile(new URL("./one-install.js", import.meta.url), "utf8"),
    readFile(
      new URL("../packages/vscode/scripts/package-vsix.cjs", import.meta.url),
      "utf8",
    ),
  ])

  assert.match(cliBuild, /target:\s*"node24"/)
  assert.match(vscodeBuild, /target:\s*"node24"/)
  assert.match(installer, /corepack pnpm install/)
  assert.match(installer, /exec "\$NODE_BIN"/)
  assert.match(
    installer,
    /\$\{HOME\}\/\.nvm\/versions\/node\/v\$\{REQUIRED_NODE_VERSION\}\/bin\/node/,
    "installer must find the pinned nvm runtime even when the nvm shell function is not loaded",
  )
  assert.match(
    installer,
    /PATH="\$\(dirname "\$NODE_BIN"\):\$PATH"/,
    "corepack and pnpm must run under the same pinned runtime selected for the wrapper",
  )
  assert.doesNotMatch(
    installer,
    /bun\.sh|find_bun|BUN_BIN|@opentui|(?:^|\n)pnpm install\n/,
  )
  assert.match(oneInstall, /execFileSync\(process\.execPath/)
  assert.ok(
    oneInstall.indexOf("execFileSync(process.execPath") <
      oneInstall.indexOf("Cleaning node_modules"),
    "runtime validation must finish before one-install removes dependencies",
  )
  assert.match(vsixPackager, /corepack pnpm exec vsce package/)
  assert.doesNotMatch(vsixPackager, /node18|(?:^|\n)pnpm exec/)
})

test("rejects every unpinned runtime", () => {
  for (const version of ["20.19.2", "22.23.1", "24.17.0", "25.8.1"]) {
    const result = validateRuntimeVersion(version)
    assert.equal(result.ok, false)
    assert.match(result.message, /Node\.js 24\.18\.0/)
  }
})
