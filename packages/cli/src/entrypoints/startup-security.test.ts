import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const entrySource = readFileSync(
  path.join(process.cwd(), "src", "entrypoints", "cli.tsx"),
  "utf8",
)
const commandsSource = readFileSync(
  path.join(process.cwd(), "src", "commands.ts"),
  "utf8",
)
const bootstrapSource = readFileSync(
  path.join(process.cwd(), "src", "nexus-bootstrap.ts"),
  "utf8",
)
const promptInputSource = readFileSync(
  path.join(process.cwd(), "src", "components", "PromptInput.tsx"),
  "utf8",
)
const replSource = readFileSync(
  path.join(process.cwd(), "src", "screens", "REPL.tsx"),
  "utf8",
)

describe("CLI startup authority ordering", () => {
  it("does not discover or connect project MCP while parsing arguments", () => {
    expect(entrySource).toContain(
      "const commands: SlashCommand[] = await getCommands(false)",
    )
    expect(commandsSource).toContain(
      "const mcpCommands = includeMcp ? await getMCPCommands() : []",
    )
  })

  it("canonicalizes and trusts the effective --project target before setup", () => {
    const actionStart = entrySource.indexOf("const requestedCwd = project")
    const setupStart = entrySource.indexOf(
      "await setup(effectiveCwd",
      actionStart,
    )
    const actionBody = entrySource.slice(actionStart, setupStart)

    expect(actionBody.indexOf("getWorkspaceTrustIdentity(requestedCwd)"))
      .toBeGreaterThanOrEqual(0)
    expect(actionBody.indexOf("await setCwd(effectiveCwd)"))
      .toBeGreaterThanOrEqual(0)
    expect(actionBody.indexOf("await showSetupScreens("))
      .toBeGreaterThan(actionBody.indexOf("await setCwd(effectiveCwd)"))
  })

  it("fails closed for an untrusted headless workspace", () => {
    const setupStart = entrySource.indexOf("async function showSetupScreens(")
    const setupEnd = entrySource.indexOf("function logStartup()", setupStart)
    const setupBody = entrySource.slice(setupStart, setupEnd)

    expect(setupBody).toContain("Refusing headless execution")
    expect(setupBody).not.toContain(
      "print mode is restricted to fail-closed",
    )
  })

  it("does not turn project permission files into host grants", () => {
    expect(bootstrapSource).not.toContain(
      "config.permissions.allowedCommands = parsed.commands",
    )
    expect(bootstrapSource).not.toContain(
      "config.permissions.allowCommandPatterns = perms.allow",
    )
    expect(bootstrapSource).not.toContain(
      "config.permissions.allowedMcpTools = perms.allowedMcpTools",
    )
    expect(bootstrapSource).toContain(
      "config.permissions.denyCommandPatterns = permissions.deny",
    )
    expect(bootstrapSource).toContain(
      "config.permissions.askCommandPatterns = permissions.ask",
    )
  })

  it("keeps administrative subcommands non-interactive", () => {
    const setupStart = entrySource.indexOf("async function setup(")
    const setupEnd = entrySource.indexOf("async function main()", setupStart)
    expect(entrySource.slice(setupStart, setupEnd)).not.toContain("render(")
    expect(entrySource).toContain(
      "await setup(doctorCwd, false, 'administrative')",
    )
    expect(entrySource).not.toContain("<Doctor")
  })

  it("does not run the inherited global-package updater from the Nexus TUI", () => {
    expect(promptInputSource).not.toContain("<AutoUpdater")
    expect(promptInputSource).not.toContain("getLatestVersion")
    expect(promptInputSource).not.toContain("installGlobalPackage")
  })

  it("shows the effective runtime index state instead of the saved preference", () => {
    expect(replSource).toContain(
      "nexusBootstrap ? !nexusNoIndex : undefined",
    )
  })

  it("restores the persisted transcript when continuing an interactive session", () => {
    expect(entrySource).toContain(
      "replProps.initialMessages ??\n        replMessagesFromSession(n.session.messages)",
    )
  })

  it("treats --mode as an explicit override instead of resetting resumed sessions", () => {
    const optionStart = entrySource.indexOf(".option(\n      '--mode <mode>'")
    const optionEnd = entrySource.indexOf("\n    )", optionStart)
    const option = entrySource.slice(optionStart, optionEnd)

    expect(optionStart).toBeGreaterThanOrEqual(0)
    expect(option).toContain("resumed sessions keep their saved mode")
    expect(option).toContain("String,")
    expect(option).not.toContain("'agent'")
  })

  it("restores an unfinished plan approval instead of showing an empty prompt", () => {
    expect(replSource).toContain(
      "getSessionModeForResume(session, 'agent') !== 'plan'",
    )
    expect(replSource).toContain("!hadPlanExit(session)")
    expect(replSource).toContain(
      "getPlanContentForFollowup(session, nexusBootstrap.cwd)",
    )
  })

  it("defers mode persistence until the active turn releases the session", () => {
    const effectStart = replSource.indexOf(
      "if (!nexusBootstrap || nexusSessionId == null) return",
    )
    const effectEnd = replSource.indexOf(
      "// Remount header on real dimension changes",
      effectStart,
    )
    const effect = replSource.slice(effectStart, effectEnd)

    expect(effectStart).toBeGreaterThanOrEqual(0)
    expect(effect).toContain("if (isLoading) return")
    expect(effect).toContain("isLoading,")
  })

  it("keeps runtime and control footers single-line in narrow terminals", () => {
    const footerStart = promptInputSource.indexOf(
      "{nexusMode != null && suggestions.length === 0",
    )
    const footerEnd = promptInputSource.indexOf(
      "{suggestions.length > 0",
      footerStart,
    )
    const footer = promptInputSource.slice(footerStart, footerEnd)

    expect(promptInputSource).toContain("const compactFooter = columns < 100")
    expect(footer.match(/wrap=\"truncate-end\"/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2)
    expect(footer).toContain("Ctrl+O output:")
    expect(footer).toContain("/diff:")
    expect(footer).not.toContain("Ctrl+I")
  })
})
