import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  skill: z.string().describe("Name of the skill to activate"),
  task_progress: z.string().optional(),
})

export const useSkillTool: ToolDef<z.infer<typeof schema>> = {
  name: "use_skill",
  description: `Read and activate a skill to gain specialized knowledge or capabilities.
Skills are markdown files with instructions, patterns, and domain knowledge.
Use when the task requires specialized knowledge documented in a skill.`,
  parameters: schema,
  readOnly: true,

  async execute({ skill }, ctx: ToolContext) {
    // Look up skill in skills config
    const skills = ctx.config.skills

    // Try to find by name
    const skillPaths = [
      ...skills,
      ...require("node:path").resolve ? [] : [],
    ]

    // Check each path
    const { readFile } = await import("node:fs/promises")
    const { resolve, basename, join } = await import("node:path")
    const { glob } = await import("glob")

    // Expand skill paths to find matching skill
    const allSkillFiles = await glob(skills.length > 0 ? skills : [".nexus/skills/**/*.md", "~/.nexus/skills/**/*.md"], {
      cwd: ctx.cwd,
      absolute: true,
    })

    // Also check standard locations
    const standardPaths = [
      join(ctx.cwd, ".nexus", "skills", skill, "SKILL.md"),
      join(ctx.cwd, ".nexus", "skills", `${skill}.md`),
    ]

    let skillContent: string | null = null
    let skillPath: string | null = null

    for (const p of [...standardPaths, ...allSkillFiles]) {
      const name = basename(p, ".md").toLowerCase()
      const parentDir = basename(resolve(p, "..")).toLowerCase()
      if (name === skill.toLowerCase() || parentDir === skill.toLowerCase()) {
        try {
          skillContent = await readFile(p, "utf8")
          skillPath = p
          break
        } catch {}
      }
    }

    if (!skillContent) {
      return {
        success: false,
        output: `Skill "${skill}" not found. Available skill locations: .nexus/skills/, ~/.nexus/skills/`,
      }
    }

    return {
      success: true,
      output: `<skill name="${skill}">\n${skillContent}\n</skill>`,
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
  description: `Control a headless browser for web automation and testing.
Actions: launch (open URL), navigate, click, type, scroll, screenshot, get_content, close.
Screenshots are returned as base64 images.
Requires puppeteer to be installed: npm install puppeteer`,
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
