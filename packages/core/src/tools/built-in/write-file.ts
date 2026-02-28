import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  path: z.string().describe("Path to the file to create or overwrite"),
  content: z.string().describe("The complete content to write to the file"),
})

export const writeFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "write_to_file",
  description: `Create a new file or completely overwrite an existing file.
Use this for: creating new files, generating boilerplate, completely restructuring a file.
For small targeted changes to existing files, prefer replace_in_file.
WARNING: This replaces the entire file content. Provide the complete final content.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ path: filePath, content }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)
    const dirPath = path.dirname(absPath)

    // Create directories if needed
    await fs.mkdir(dirPath, { recursive: true })

    // Atomic write: write to temp file, then rename
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`
    try {
      await fs.writeFile(tmpPath, content, "utf8")
      await fs.rename(tmpPath, absPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      return { success: false, output: `Failed to write ${filePath}: ${(err as Error).message}` }
    }

    const lines = content.split("\n").length
    return {
      success: true,
      output: `Successfully wrote ${filePath} (${lines} lines)`,
    }
  },
}
