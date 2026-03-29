import * as path from "node:path"
import * as os from "node:os"

const GLOBAL_NEXUS = path.join(os.homedir(), ".nexus")

/** Marketplace skills install only under Nexus dirs (project `.nexus/skills` or `~/.nexus/skills`). */
export class MarketplacePaths {
  mcpServersJsonPath(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") {
      return path.join(workspace!, ".nexus", "mcp-servers.json")
    }
    return path.join(GLOBAL_NEXUS, "mcp-servers.json")
  }

  skillsDir(scope: "project" | "global", workspace?: string): string {
    if (scope === "project") {
      return path.join(workspace!, ".nexus", "skills")
    }
    return path.join(GLOBAL_NEXUS, "skills")
  }
}
