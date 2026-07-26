import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { promisify } from "node:util"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const contextModeRoot = join(repositoryRoot, "sources", "claude-context-mode")

export async function buildOptionalContextMode({ sourceExists, run }) {
  if (!sourceExists) return { status: "skipped" }
  await run()
  return { status: "built" }
}

async function runNpm(args) {
  await execFileAsync("npm", args, {
    cwd: contextModeRoot,
    windowsHide: true,
  })
}

async function runContextModeBuild() {
  await runNpm(["install", "--silent"])
  await runNpm(["run", "build"])

  const manifest = JSON.parse(readFileSync(join(contextModeRoot, "package.json"), "utf8"))
  if (typeof manifest.scripts?.bundle === "string") {
    await runNpm(["run", "bundle"])
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildOptionalContextMode({
    sourceExists: existsSync(contextModeRoot),
    run: runContextModeBuild,
  })
  if (result.status === "skipped") {
    console.log("Optional claude-context-mode source is absent; skipping its build.")
  }
}
