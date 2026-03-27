import * as path from "node:path"
import * as os from "node:os"

const GLOBAL_NEXUS = path.join(os.homedir(), ".nexus")

/** Kilo-compatible layout: marketplace skills install to `.kilo/skills/<id>` (project or global). */
export class MarketplacePaths {
  mcpServersJsonPath(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") {
      return path.join(workspace!, ".nexus", "mcp-servers.json")
    }
    return path.join(GLOBAL_NEXUS, "mcp-servers.json")
  }

  skillsDir(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") {
      return path.join(workspace!, ".kilo", "skills")
    }
    return path.join(os.homedir(), ".kilo", "skills")
  }

  /** Legacy installs under ~/.nexus/skills or project .nexus/skills (before Kilo layout). */
  legacySkillsDir(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") {
      return path.join(workspace!, ".nexus", "skills")
    }
    return path.join(GLOBAL_NEXUS, "skills")
  }
}
