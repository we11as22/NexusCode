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
  const [
    rootPackageText,
    cliPackageText,
    cliBuild,
    vscodeBuild,
    installer,
    extensionInstaller,
    oneInstall,
    vsixPackager,
  ] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
    readFile(new URL("../packages/cli/tsup.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/vscode/esbuild.mjs", import.meta.url), "utf8"),
    readFile(new URL("./install-nexus-cli.sh", import.meta.url), "utf8"),
    readFile(new URL("./install-nexus-vscode.sh", import.meta.url), "utf8"),
    readFile(new URL("./one-install.js", import.meta.url), "utf8"),
    readFile(
      new URL("../packages/vscode/scripts/package-vsix.cjs", import.meta.url),
      "utf8",
    ),
  ])
  const rootPackage = JSON.parse(rootPackageText)
  const cliPackage = JSON.parse(cliPackageText)

  assert.match(cliBuild, /target:\s*"node24"/)
  assert.match(vscodeBuild, /target:\s*"node24"/)
  assert.equal(rootPackage.scripts?.extension, "sh scripts/install-nexus-vscode.sh")
  assert.equal(rootPackage.scripts?.["install-vscode"], "pnpm run extension")
  assert.equal(cliPackage.dependencies?.["@vscode/ripgrep"], "1.18.0")
  assert.match(cliPackage.scripts?.build ?? "", /copy-ripgrep/)
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
  assert.match(extensionInstaller, /corepack pnpm install/)
  assert.match(extensionInstaller, /corepack pnpm package:vscode/)
  assert.match(extensionInstaller, /code-insiders|Visual Studio Code\.app/)
  assert.match(extensionInstaller, /Cursor\.app\/Contents\/Resources\/app\/bin\/cursor/)
  assert.match(
    extensionInstaller,
    /mdfind[\s\S]*com\.microsoft\.VSCode/,
    "installer must discover a VS Code app outside the conventional Applications folders",
  )
  assert.match(
    extensionInstaller,
    /AppTranslocation/,
    "installer must discover the currently running macOS-translocated VS Code app",
  )
  assert.match(
    extensionInstaller,
    /\$\{HOME\}\/Downloads\/Visual Studio Code\.app/,
    "installer must support a downloaded VS Code app before it is moved to Applications",
  )
  assert.match(extensionInstaller, /--install-extension/)
  assert.match(extensionInstaller, /--list-extensions/)
  assert.match(
    extensionInstaller,
    /if \[ -z "\$CODE_BIN" \]; then[\s\S]*?exit 1[\s\S]*?fi/,
    "default extension install must fail rather than report success when no compatible editor exists",
  )
  assert.match(
    extensionInstaller,
    /\$\{HOME\}\/\.nvm\/versions\/node\/v\$\{REQUIRED_NODE_VERSION\}\/bin\/node/,
  )
  assert.match(oneInstall, /execFileSync\(process\.execPath/)
  assert.ok(
    oneInstall.indexOf("execFileSync(process.execPath") <
      oneInstall.indexOf("Installing dependencies"),
    "runtime validation must finish before one-install invokes pnpm",
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
