import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPORT_COLUMNS = [
  "feature",
  "declared",
  "registered",
  "mode-visible",
  "executed-by",
  "persisted-by",
  "rendered-cli",
  "rendered-vscode",
  "rendered-server",
  "tests",
  "status",
]

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
])

async function walk(root, relative = "") {
  const absolute = path.join(root, relative)
  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch {
    return []
  }

  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...await walk(root, child))
      }
    } else if (entry.isFile()) {
      files.push(child.replaceAll(path.sep, "/"))
    }
  }
  return files
}

async function readTextFiles(root) {
  const paths = await walk(root)
  const text = new Map()
  for (const relative of paths) {
    if (!/\.(?:ts|tsx|js|mjs|cjs|json|md)$/.test(relative)) continue
    const absolute = path.join(root, relative)
    const info = await stat(absolute).catch(() => null)
    if (!info || info.size > 2_000_000) continue
    text.set(relative, await readFile(absolute, "utf8"))
  }
  return text
}

function createEvidenceRow(feature, kind) {
  return {
    feature,
    kind,
    declared: new Set(),
    registered: new Set(),
    modeVisible: new Set(),
    executedBy: new Set(),
    persistedBy: new Set(),
    renderedCli: new Set(),
    renderedVscode: new Set(),
    renderedServer: new Set(),
    tests: new Set(),
    documented: new Set(),
    compatibilityOnly: false,
  }
}

function ensureRow(rows, feature, kind) {
  let row = rows.get(feature)
  if (!row) {
    row = createEvidenceRow(feature, kind)
    rows.set(feature, row)
  }
  return row
}

function addMatches(set, source, pattern, mapper = (match) => match[1]) {
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(source)) !== null) {
    const value = mapper(match)
    if (value) set.add(value)
  }
}

function testFilesContaining(files, value) {
  const found = []
  for (const [relative, source] of files) {
    if (!/(?:^|\/)[^/]*\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(relative)) {
      continue
    }
    if (source.includes(value)) found.push(relative)
  }
  return found
}

function sourceConsumers(files, value, excluded = new Set()) {
  const found = []
  for (const [relative, source] of files) {
    if (excluded.has(relative)) continue
    if (!relative.includes("/src/")) continue
    if (source.includes(value)) found.push(relative)
  }
  return found
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function settingConsumers(files, setting, manifestPath) {
  const dot = setting.lastIndexOf(".")
  const namespace = dot > 0 ? setting.slice(0, dot) : ""
  const key = dot > 0 ? setting.slice(dot + 1) : setting
  const keyAccess = new RegExp(
    `\\.(?:get|inspect|update)(?:<[^>]+>)?\\(\\s*["']${escapeRegex(key)}["']`,
  )
  const explicitReaderAccess = new RegExp(
    `\\bread(?:<[^>]+>)?\\(\\s*["']${escapeRegex(key)}["']`,
  )
  const explicitReaderWrapperAccess = new RegExp(
    `\\b[A-Za-z_$][\\w$]*\\(\\s*read\\s*,\\s*["']${escapeRegex(key)}["']`,
  )
  const namespaceAccess = namespace
    ? new RegExp(
        `getConfiguration\\(\\s*["']${escapeRegex(namespace)}["']\\s*\\)`,
      )
    : null
  const found = []
  for (const [relative, source] of files) {
    if (relative === manifestPath || !relative.includes("/src/")) continue
    if (
      source.includes(setting) ||
      ((source.includes("ExplicitSettingReader") ||
        source.includes("applyExplicitConfigOverrides")) &&
        (explicitReaderAccess.test(source) ||
          explicitReaderWrapperAccess.test(source))) ||
      (namespaceAccess?.test(source) &&
        (keyAccess.test(source) ||
          source.includes(`"${key}"`) ||
          source.includes(`'${key}'`)))
    ) {
      found.push(relative)
    }
  }
  return found
}

function extractToolDefinitions(files) {
  const definitions = new Map()
  const toolSourcePattern =
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[\s\S]{0,240}?)?=\s*\{[\s\S]{0,1600}?name:\s*["']([A-Z][A-Za-z0-9]+)["']/g

  for (const [relative, source] of files) {
    if (!relative.startsWith("packages/core/src/")) continue
    if (!relative.includes("/tools/") && !relative.includes("/agent/")) continue
    toolSourcePattern.lastIndex = 0
    let match
    while ((match = toolSourcePattern.exec(source)) !== null) {
      const variable = match[1]
      const name = match[2]
      if (!variable || !name) continue
      const definitionWindow = source.slice(match.index, match.index + 800)
      definitions.set(variable, {
        name,
        relative,
        hiddenFromAgent: /hiddenFromAgent\s*:\s*true/.test(definitionWindow),
      })
    }
  }
  return definitions
}

function extractModeVisibleTools(files) {
  const source = files.get("packages/core/src/agent/modes.ts") ?? ""
  const start = source.indexOf("TOOL_GROUP_MEMBERS")
  if (start < 0) return new Set()
  const endCandidates = [
    source.indexOf("PLAN_MODE_ALLOWED_WRITE_PATTERN", start),
    source.indexOf("READ_ONLY_TOOLS", start),
  ].filter((value) => value > start)
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : source.length
  const section = source.slice(start, end)
  const names = new Set()
  addMatches(names, section, /["']([A-Z][A-Za-z0-9]+)["']/g)
  return names
}

function classify(row) {
  const hasDeclared = row.declared.size > 0
  const hasRegistered = row.registered.size > 0
  const hasMode = row.modeVisible.size > 0
  const hasTests = row.tests.size > 0

  if (row.kind === "setting" && row.renderedVscode.size === 0) {
    return "orphan-setting"
  }
  if (row.kind === "tool" && row.compatibilityOnly && hasRegistered) {
    return "compatibility-only"
  }
  if (
    row.documented.size > 0 &&
    !hasDeclared &&
    !hasRegistered
  ) {
    return "documentation-only"
  }
  if (row.kind === "tool" && hasRegistered && !hasMode) {
    return "unreachable"
  }
  if (
    row.kind === "event" &&
    (row.renderedCli.size === 0 ||
      row.renderedVscode.size === 0 ||
      row.renderedServer.size === 0)
  ) {
    return "surface-gap"
  }
  if (
    (row.kind === "setting" || row.kind === "vscode-command") &&
    row.renderedVscode.size === 0
  ) {
    return "surface-gap"
  }
  if (hasTests && (hasRegistered || hasMode)) {
    return "working-evidence"
  }
  if (hasRegistered || hasMode || hasDeclared) {
    return "reachable-untested"
  }
  return "documentation-only"
}

function compactEvidence(values) {
  if (values.size === 0) return "—"
  return [...values].sort().join("<br>")
}

function finalize(row) {
  return {
    feature: row.feature,
    declared: compactEvidence(row.declared),
    registered: compactEvidence(row.registered),
    "mode-visible": compactEvidence(row.modeVisible),
    "executed-by": compactEvidence(row.executedBy),
    "persisted-by": compactEvidence(row.persistedBy),
    "rendered-cli": compactEvidence(row.renderedCli),
    "rendered-vscode": compactEvidence(row.renderedVscode),
    "rendered-server": compactEvidence(row.renderedServer),
    tests: compactEvidence(row.tests),
    status: classify(row),
  }
}

export async function collectFeatureCensus(root) {
  const files = await readTextFiles(root)
  const rows = new Map()
  const toolDefinitions = extractToolDefinitions(files)
  const modeVisible = extractModeVisibleTools(files)
  const builtinIndex =
    files.get("packages/core/src/tools/built-in/index.ts") ?? ""
  const pipelineExists = files.has("packages/core/src/agent/tool-pipeline.ts")
  const toolPersistenceExists =
    (files.get("packages/core/src/session/index.ts") ?? "").includes("addToolPart")
  const cliToolRendering =
    (files.get("packages/cli/src/nexus-query.ts") ?? "").includes("tool_start")
  const vscodeToolRendering =
    (files.get("packages/vscode/src/controller.ts") ?? "").includes("tool_start")
  const serverToolTransport =
    (files.get("packages/server/src/routes/session.ts") ?? "").includes("appendRunEvent")

  for (const [variable, definition] of toolDefinitions) {
    const row = ensureRow(rows, `tool:${definition.name}`, "tool")
    row.declared.add(definition.relative)
    row.compatibilityOnly = definition.hiddenFromAgent
    if (new RegExp(`\\b${variable}\\b`).test(builtinIndex)) {
      row.registered.add("getAllBuiltinTools")
    }
    if (modeVisible.has(definition.name)) {
      row.modeVisible.add("TOOL_GROUP_MEMBERS")
    }
    if (pipelineExists) row.executedBy.add("tool-pipeline")
    if (toolPersistenceExists) row.persistedBy.add("session tool parts")
    if (cliToolRendering) row.renderedCli.add("tool events")
    if (vscodeToolRendering) row.renderedVscode.add("tool events")
    if (serverToolTransport) row.renderedServer.add("NDJSON tool events")
  }

  for (const name of modeVisible) {
    const row = ensureRow(rows, `tool:${name}`, "tool")
    row.modeVisible.add("TOOL_GROUP_MEMBERS")
    if (pipelineExists) row.executedBy.add("tool-pipeline")
  }

  for (const [relative, source] of files) {
    if (!relative.startsWith("docs/") || !relative.endsWith(".md")) continue
    const documentedTools = new Set()
    addMatches(
      documentedTools,
      source,
      /^#{2,4}\s+(?:Tool:?\s+([A-Z][A-Za-z0-9]+)|([A-Z][A-Za-z0-9]*Tool))\s*$/gm,
      (match) => match[1] ?? match[2],
    )
    for (const name of documentedTools) {
      ensureRow(rows, `tool:${name}`, "tool").documented.add(relative)
    }
  }

  const typeSource = files.get("packages/core/src/types.ts") ?? ""
  const eventStart = typeSource.indexOf("export type AgentEvent")
  if (eventStart >= 0) {
    const eventSection = typeSource.slice(eventStart, eventStart + 60_000)
    const eventNames = new Set()
    addMatches(eventNames, eventSection, /type:\s*["']([a-z][a-z0-9_]+)["']/g)
    const cliSource = files.get("packages/cli/src/nexus-query.ts") ?? ""
    const vscodeSource = files.get("packages/vscode/src/controller.ts") ?? ""
    const serverSource = [
      files.get("packages/server/src/routes/session.ts") ?? "",
      files.get("packages/server/src/active-runs.ts") ?? "",
    ].join("\n")
    for (const name of eventNames) {
      const row = ensureRow(rows, `event:${name}`, "event")
      row.declared.add("AgentEvent")
      row.registered.add("AgentEvent union")
      if (cliSource.includes(`'${name}'`) || cliSource.includes(`"${name}"`)) {
        row.renderedCli.add("nexus-query")
      }
      if (
        vscodeSource.includes(`'${name}'`) ||
        vscodeSource.includes(`"${name}"`)
      ) {
        row.renderedVscode.add("controller")
      }
      if (
        serverSource.includes(`'${name}'`) ||
        serverSource.includes(`"${name}"`) ||
        serverSource.includes("appendRunEvent")
      ) {
        row.renderedServer.add("NDJSON transport")
      }
    }
  }

  const vscodePackagePath = "packages/vscode/package.json"
  const vscodePackageSource = files.get(vscodePackagePath)
  if (vscodePackageSource) {
    try {
      const manifest = JSON.parse(vscodePackageSource)
      const properties =
        manifest?.contributes?.configuration?.properties ?? {}
      for (const setting of Object.keys(properties).sort()) {
        const row = ensureRow(rows, `setting:${setting}`, "setting")
        row.declared.add(vscodePackagePath)
        row.registered.add("VS Code configuration")
        for (const consumer of settingConsumers(
          files,
          setting,
          vscodePackagePath,
        )) {
          row.renderedVscode.add(consumer)
        }
      }
      for (const contribution of manifest?.contributes?.commands ?? []) {
        const command = contribution?.command
        if (typeof command !== "string" || !command) continue
        const row = ensureRow(rows, `vscode-command:${command}`, "vscode-command")
        row.declared.add(vscodePackagePath)
        row.registered.add("VS Code commands")
        for (const consumer of sourceConsumers(
          files,
          command,
          new Set([vscodePackagePath]),
        )) {
          row.renderedVscode.add(consumer)
        }
      }
    } catch {
      // Invalid manifests are caught by package/build validation; the census
      // remains usable and simply omits unparseable contributions.
    }
  }

  const cliSource =
    files.get("packages/cli/src/entrypoints/cli.tsx") ??
    files.get("packages/cli/src/index.ts") ??
    ""
  const cliCommands = new Set()
  addMatches(cliCommands, cliSource, /\.command\(\s*["']([^"']+)["']/g)
  for (const command of cliCommands) {
    const row = ensureRow(rows, `cli-command:${command}`, "cli-command")
    row.declared.add("CLI command")
    row.registered.add("Commander")
    row.executedBy.add("CLI action")
    row.renderedCli.add("CLI help")
  }
  const cliOptions = new Set()
  addMatches(
    cliOptions,
    cliSource,
    /\.option\(\s*["'][^"']*(--[a-z0-9-]+)/g,
  )
  for (const option of cliOptions) {
    const row = ensureRow(rows, `cli-option:${option}`, "cli-command")
    row.declared.add("CLI option")
    row.registered.add("Commander")
    row.executedBy.add("CLI action")
    row.renderedCli.add("CLI help")
  }

  for (const [relative, source] of files) {
    if (!relative.startsWith("packages/server/src/")) continue
    const routePattern =
      /\b(?:app|router|routes|[A-Za-z0-9_]+Routes)\.(get|post|put|delete)\(\s*["']([^"']+)["']/g
    routePattern.lastIndex = 0
    let match
    while ((match = routePattern.exec(source)) !== null) {
      const method = match[1]?.toUpperCase()
      const localPath = match[2]
      if (!method || !localPath) continue
      const prefix = relative.includes("/routes/session") ? "/session" : ""
      const fullPath = `${prefix}${localPath === "/" ? "" : localPath}` || "/"
      const route = `${method} ${fullPath}`
      const row = ensureRow(rows, `server-route:${route}`, "server-route")
      row.declared.add(relative)
      row.registered.add("Hono route")
      row.executedBy.add("Hono")
      row.renderedServer.add("HTTP")
    }
  }

  for (const row of rows.values()) {
    const rawName = row.feature.slice(row.feature.indexOf(":") + 1)
    const testNeedle =
      row.kind === "tool" || row.kind === "event"
        ? rawName
        : row.feature
    for (const testPath of testFilesContaining(files, testNeedle)) {
      row.tests.add(testPath)
    }
  }

  return [...rows.values()]
    .map(finalize)
    .sort((a, b) => a.feature.localeCompare(b.feature))
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

export function renderFeatureCensus(rows) {
  const lines = [
    "# NexusCode executable feature census",
    "",
    "Generated by `node scripts/feature-census.mjs`. Static reachability is not proof of runtime correctness: only a linked test can produce `working-evidence`.",
    "",
    `| ${REPORT_COLUMNS.join(" | ")} |`,
    `| ${REPORT_COLUMNS.map(() => "---").join(" | ")} |`,
  ]
  for (const row of rows) {
    lines.push(
      `| ${REPORT_COLUMNS.map((column) => escapeCell(row[column] ?? "—")).join(" | ")} |`,
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

async function main() {
  const root = process.cwd()
  const outputFlag = process.argv.indexOf("--output")
  const output =
    outputFlag >= 0 && process.argv[outputFlag + 1]
      ? path.resolve(root, process.argv[outputFlag + 1])
      : path.join(root, "docs", "engineering", "feature-census.md")
  const report = renderFeatureCensus(await collectFeatureCensus(root))

  if (process.argv.includes("--check")) {
    const committed = await readFile(output, "utf8").catch(() => "")
    if (committed !== report) {
      process.stderr.write(
        `[nexus] Feature census is stale: ${path.relative(root, output)}. Run pnpm census:features.\n`,
      )
      process.exitCode = 1
    }
    return
  }

  const temporary = `${output}.tmp-${process.pid}`
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(temporary, report, "utf8")
  await rename(temporary, output)
  process.stdout.write(
    `[nexus] Wrote ${path.relative(root, output)} (${report.split("\n").length - 7} features)\n`,
  )
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
