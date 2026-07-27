import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const bootstrapSource = readFileSync(
  path.join(process.cwd(), "src", "nexus-bootstrap.ts"),
  "utf8",
)
const querySource = readFileSync(
  path.join(process.cwd(), "src", "nexus-query.ts"),
  "utf8",
)
const replSource = readFileSync(
  path.join(process.cwd(), "src", "screens", "REPL.tsx"),
  "utf8",
)

describe("CLI credential wiring", () => {
  it("keeps bootstrap config non-secret and materializes integrations from separate configs", () => {
    expect(bootstrapSource).toContain("const runtimeConfig =")
    expect(bootstrapSource).not.toContain(
      "config = await finalizeConfigCredentials(",
    )
    expect(bootstrapSource).toContain(
      "createRunContext(config, runtimeConfig)",
    )
  })

  it("rebuilds subagent tools per run while the agent loop receives safe config", () => {
    expect(querySource).toContain(
      "nexus.createRunContext(config, runtimeConfig)",
    )
    expect(querySource).toContain("createLLMClient(runtimeConfig.model)")
    const loopStart = querySource.indexOf("await runAgentLoop({")
    const loopBody = querySource.slice(loopStart, loopStart + 500)
    expect(loopBody).toContain("config,")
    expect(loopBody).not.toContain("config: runtimeConfig")
  })

  it("hydrates exact workspace authority before compaction resolves credentials", () => {
    expect(replSource).toContain(
      "loadCliWorkspaceConfig(nexusBootstrap.cwd",
    )
    expect(replSource).not.toContain(
      "loadConfig(nexusBootstrap.cwd",
    )
  })
})
