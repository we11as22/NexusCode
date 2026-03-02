import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import { loadSkills } from "../../skills/manager.js"

const schema = z.object({
  skill: z.string().describe("Name of the skill to activate"),
  task_progress: z.string().optional(),
})

export const useSkillTool: ToolDef<z.infer<typeof schema>> = {
  name: "use_skill",
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

const browserSchema = z.object({
  action: z.enum([
    "launch", "screenshot", "click", "type", "scroll",
    "navigate", "close", "get_content",
  ]).describe("Browser action to perform"),
  url: z.string().optional().describe("URL to navigate to (for 'launch' and 'navigate')"),
  selector: z.string().optional().describe("CSS selector or element description (for 'click', 'type', 'scroll')"),
  text: z.string().optional().describe("Text to type (for 'type')"),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().optional(),
  task_progress: z.string().optional(),
})

export const browserActionTool: ToolDef<z.infer<typeof browserSchema>> = {
  name: "browser_action",
  description: `Control a headless browser (Puppeteer). Actions: launch, navigate, click, type, scroll, screenshot, get_content, close. Screenshots as base64. Requires: npm install puppeteer.

When to use:
- E2E testing, scraping a known URL, checking rendered output.
- User asks to "open" or "check" a web page.

When NOT to use:
- Fetching API or docs: use web_fetch.
- General web search: use web_search.`,
  parameters: browserSchema,
  requiresApproval: true,

  async execute({ action, url, selector, text, scroll_direction, scroll_amount }, ctx: ToolContext) {
    let puppeteer: { launch: Function } | null = null
    try {
      puppeteer = await import("puppeteer" as string as any) as any
    } catch {
      return {
        success: false,
        output: "Browser actions require puppeteer. Install with: npm install puppeteer",
      }
    }

    // Simple stateless browser — opens fresh for each launch
    if (action === "launch") {
      if (!url) return { success: false, output: "URL required for launch action" }

      let browser: { close(): Promise<void>; newPage(): Promise<any> } | null = null
      try {
        browser = await puppeteer!.launch({ headless: true, args: ["--no-sandbox"] })
        const page = await browser!.newPage()
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 })

        const title = await page.title()
        const screenshot = await page.screenshot({ encoding: "base64", type: "png" }) as string
        const screenshotKB = Math.round(Buffer.from(screenshot, "base64").length / 1024)

        // Cap screenshot at 1MB
        if (screenshotKB > 1024) {
          return {
            success: true,
            output: `Launched browser at: ${url}\nPage title: ${title}\nScreenshot too large (${screenshotKB}KB), use get_content instead.`,
          }
        }

        return {
          success: true,
          output: `Launched browser at: ${url}\nPage title: ${title}`,
          attachments: [{ type: "image", content: screenshot, mimeType: "image/png" }],
        }
      } finally {
        await browser?.close()
      }
    }

    return { success: false, output: `Action '${action}' requires an active browser session.` }
  },
}
