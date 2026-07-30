import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sandboxRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const destinationRoot = path.resolve(process.cwd(), process.argv[2] ?? ".")
const requested = process.env.NEXUS_SANDBOX_TARGETS?.trim()
const targets = requested
  ? requested.split(",").map((value) => value.trim()).filter(Boolean)
  : [`${process.platform}-${process.arch}`]

for (const target of targets) {
  if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) {
    throw new Error(`Invalid Nexus sandbox target: ${target}`)
  }
  const binaryName = target.startsWith("win32-")
    ? "nexus-sandbox.exe"
    : "nexus-sandbox"
  const source = path.join(sandboxRoot, "vendor", target, binaryName)
  const destination = path.join(
    destinationRoot,
    "vendor",
    target,
    binaryName,
  )
  if (!fs.existsSync(source)) {
    throw new Error(
      `Nexus sandbox binary was not built for ${target}: ${source}`,
    )
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  if (!target.startsWith("win32-")) fs.chmodSync(destination, 0o755)
  if (target.startsWith("linux-")) {
    for (const file of ["nexus-bwrap", "COPYING.bubblewrap"]) {
      const companionSource = path.join(
        sandboxRoot,
        "vendor",
        target,
        file,
      )
      const companionDestination = path.join(
        destinationRoot,
        "vendor",
        target,
        file,
      )
      if (!fs.existsSync(companionSource)) {
        throw new Error(
          `Nexus Linux sandbox companion is missing: ${companionSource}`,
        )
      }
      fs.copyFileSync(companionSource, companionDestination)
      if (file === "nexus-bwrap") fs.chmodSync(companionDestination, 0o755)
    }
  }
  process.stdout.write(
    `[nexus-sandbox] copied ${target}: ${destination}\n`,
  )
}
