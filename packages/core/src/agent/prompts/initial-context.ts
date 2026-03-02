import * as fs from "node:fs/promises"

const KEY_FILES = new Set([
  "package.json",
  "README.md",
  "README",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
  ".env.example",
  ".gitignore",
])

const MAX_TOP_LEVEL = 40

/**
 * Build a short "initial project context" string: top-level dirs and key files.
 * Used at agent start so the model has a quick overview of the project layout.
 */
export async function getInitialProjectContext(cwd: string): Promise<string> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    const dirs: string[] = []
    const files: string[] = []

    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example" && e.name !== ".gitignore") continue
      if (e.isDirectory()) {
        dirs.push(`${e.name}/`)
      } else if (e.isFile() && KEY_FILES.has(e.name)) {
        files.push(e.name)
      }
    }

    dirs.sort()
    files.sort()
    const all = [...dirs, ...files].slice(0, MAX_TOP_LEVEL)
    if (all.length === 0) return ""

    return [
      "Project root (top-level):",
      all.join(" "),
    ].join("\n")
  } catch {
    return ""
  }
}
