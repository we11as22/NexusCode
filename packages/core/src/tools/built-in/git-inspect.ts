import { z } from "zod"

import { GitService } from "../../git/service.js"
import type { ToolContext, ToolDef } from "../../types.js"

const revisionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/@~^{}:+-]*$/,
    "revision contains unsupported characters",
  )
  .refine((value) => !value.startsWith("-"), "revision cannot begin with '-'")

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith("-"), "path cannot begin with '-'")
  .refine(
    (value) => !value.includes("\0") && !value.includes("\n") && !value.includes("\r"),
    "path cannot contain NUL or line breaks",
  )

const schema = z
  .object({
    operation: z.enum(["status", "diff", "show", "log", "blame"]),
    revision: revisionSchema.optional(),
    path: pathSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.operation === "blame" && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "path is required for blame",
      })
    }
    if (value.operation === "status" && value.revision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "status does not accept a revision",
      })
    }
  })

type GitInspectArgs = z.infer<typeof schema>

export const gitInspectTool: ToolDef<GitInspectArgs> = {
  name: "GitInspect",
  searchHint: "read-only git status diff show log blame repository inspection",
  description:
    "Inspect Git state without exposing an arbitrary shell. Supports only status, diff, show, log, and blame with validated revision/path arguments.",
  parameters: schema,
  readOnly: true,
  modes: ["review"],

  async execute(args, ctx: ToolContext) {
    const git = ctx.services.git ?? new GitService(ctx.cwd)

    if (args.operation === "status") {
      const status = await git.status()
      return {
        success: status.available,
        output: status.available
          ? JSON.stringify(status, null, 2)
          : "Git repository is not available in this workspace.",
        metadata: {
          operation: args.operation,
          available: status.available,
        },
      }
    }

    if (args.operation === "diff") {
      const diff = await git.diff({
        scope: args.revision ? "range" : "combined",
        ...(args.revision
          ? { from: args.revision, to: "HEAD" }
          : {}),
        ...(args.path ? { paths: [args.path] } : {}),
        detail: "patch",
      })
      return {
        success: diff.available,
        output: diff.available
          ? JSON.stringify(diff, null, 2)
          : "Git repository is not available in this workspace.",
        metadata: {
          operation: args.operation,
          available: diff.available,
          fileCount: diff.files.length,
          omissions: diff.omissions.length,
        },
      }
    }

    const result = await git.inspectText({
      operation: args.operation,
      ...(args.revision ? { revision: args.revision } : {}),
      ...(args.path ? { path: args.path } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    })
    return {
      success: result.exitCode === 0,
      output:
        result.output ||
        (result.exitCode === 0
          ? "(no output)"
          : `Git exited with code ${result.exitCode}`),
      metadata: {
        operation: args.operation,
        exitCode: result.exitCode,
        argv: result.argv,
        truncated: result.truncated,
      },
    }
  },
}
