import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import { loadSkills } from "../../skills/manager.js"

const schema = z.object({
  skill: z.string().describe("Name of the skill to activate"),
  task_progress: z.string().optional(),
})

export const useSkillTool: ToolDef<z.infer<typeof schema>> = {
  name: "Skill",
  description: `Load a skill's content (markdown) for specialized knowledge. Skills live in .nexus/skills/ or ~/.nexus/skills/ (same resolution as classifier).

When to use:
- Task matches a skill's domain (e.g. testing, deployment, framework).
- You need patterns or instructions from a project skill file.

When NOT to use:
- General coding: skills are optional and add context.
- If the skill name is unknown: list .nexus/skills/ or rely on classifier-selected skills.`,
  parameters: schema,
  readOnly: true,

  async execute({ skill }, ctx: ToolContext) {
    const skillPaths = ctx.config.skills ?? []
    const loaded = await loadSkills(skillPaths, ctx.cwd).catch(() => [])

    const nameLower = skill.trim().toLowerCase()
    const found = loaded.find(
      (s) => s.name.toLowerCase() === nameLower
    )

    if (!found) {
      const available = loaded.length > 0
        ? loaded.map((s) => s.name).slice(0, 20).join(", ")
        : "none (add paths in config or create .nexus/skills/<name>/SKILL.md)"
      return {
        success: false,
        output: `Skill "${skill}" not found. Available skills: ${available}.`,
      }
    }

    return {
      success: true,
      output: `<skill name="${found.name}">\n${found.content}\n</skill>`,
    }
  },
}
