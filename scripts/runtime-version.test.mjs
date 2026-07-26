import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { validateRuntimeVersion } from "./runtime-version.mjs"

test("accepts the pinned Node release", () => {
  assert.deepEqual(validateRuntimeVersion("20.19.2"), { ok: true })
})

test("build and installer surfaces target the pinned Node 20 runtime", async () => {
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

  assert.match(cliBuild, /target:\s*"node20"/)
  assert.match(vscodeBuild, /target:\s*"node20"/)
  assert.match(installer, /corepack pnpm install/)
  assert.match(installer, /exec "\$NODE_BIN"/)
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

test("rejects Node 18, older Node 20, and a different major", () => {
  for (const version of ["18.20.8", "20.18.3", "21.7.3", "22.0.0", "25.8.1"]) {
    const result = validateRuntimeVersion(version)
    assert.equal(result.ok, false)
    assert.match(result.message, /Node\.js 20\.19\.2/)
  }
})
