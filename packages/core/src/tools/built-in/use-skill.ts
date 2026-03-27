import { z } from "zod"
import { pathToFileURL } from "node:url"
import type { ToolDef, ToolContext, NexusConfig } from "../../types.js"
import {
  buildSkillToolDynamicDescription,
  loadSkillToolCatalogRows,
  resolveSkillBody,
  sampleSkillSiblingFiles,
} from "../../skills/skill-tool-catalog.js"

const schema = z.object({
  name: z.string().min(1).describe("Exact skill name from <available_skills> in this tool's description (or Active Skills)"),
  task_progress: z.string().optional(),
})

export const SKILL_TOOL_PLACEHOLDER_DESCRIPTION = buildSkillToolDynamicDescription([])

export async function buildSkillToolDescriptionMerged(cwd: string, config: NexusConfig): Promise<string> {
  const rows = await loadSkillToolCatalogRows(cwd, config).catch(() => [])
  return buildSkillToolDynamicDescription(rows)
}

export const useSkillTool: ToolDef<z.infer<typeof schema>> = {
  name: "Skill",
  description: SKILL_TOOL_PLACEHOLDER_DESCRIPTION,
  parameters: schema,
  readOnly: true,

  async execute({ name }, ctx: ToolContext) {
    const resolved = await resolveSkillBody(name, ctx.cwd, ctx.config)
    if (!resolved) {
      const rows = await loadSkillToolCatalogRows(ctx.cwd, ctx.config).catch(() => [])
      const available = rows.length > 0 ? rows.map((r) => r.name).slice(0, 30).join(", ") : "none discovered"
      return {
        success: false,
        output: `Skill "${name}" not found. Available: ${available}.`,
      }
    }

    const base = pathToFileURL(resolved.skillDir).href
    const files = await sampleSkillSiblingFiles(resolved.skillDir, ctx.signal)
    const fileBlock = files.map((f) => `<file>${f}</file>`).join("\n")

    return {
      success: true,
      output: [
        `<skill_content name="${resolved.displayName}">`,
        `# Skill: ${resolved.displayName}`,
        "",
        resolved.content.trim(),
        "",
        `Base directory for this skill: ${base}`,
        "Relative paths in this skill (e.g. scripts/, reference/) are relative to this base directory.",
        "Note: file list is sampled.",
        "",
        "<skill_files>",
        fileBlock,
        "</skill_files>",
        "</skill_content>",
      ].join("\n"),
      metadata: {
        name: resolved.displayName,
        dir: resolved.skillDir,
      },
    }
  },
}
