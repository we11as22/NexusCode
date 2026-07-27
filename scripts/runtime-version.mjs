const REQUIRED_NODE_VERSION = "24.18.0"

export function validateRuntimeVersion(version) {
  if (version === REQUIRED_NODE_VERSION) return { ok: true }

  return {
    ok: false,
    message:
      `NexusCode requires Node.js ${REQUIRED_NODE_VERSION}; current runtime is ${version}. ` +
      "Run `nvm use` from the repository root.",
  }
}

export function assertRuntimeVersion(version = process.versions.node) {
  const result = validateRuntimeVersion(version)
  if (!result.ok) {
    console.error(result.message)
    process.exitCode = 1
  }
  return result.ok
}

export async function assertBuiltinSqlite() {
  const sqlite = await import("node:sqlite")
  if (typeof sqlite.DatabaseSync !== "function") {
    throw new Error(
      "NexusCode requires the built-in node:sqlite DatabaseSync API.",
    )
  }
  return true
}

export { REQUIRED_NODE_VERSION }
