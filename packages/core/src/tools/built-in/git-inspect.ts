import { z } from "zod"

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

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildCommand({
  operation,
  revision,
  path,
  limit,
}: GitInspectArgs): string {
  const pathspec = path ? ` -- ${quoteShellArgument(path)}` : ""

  switch (operation) {
    case "status":
      return `git status --short --branch${pathspec}`
    case "diff":
      return `git diff --no-ext-diff --no-color${revision ? ` ${quoteShellArgument(revision)}` : ""}${pathspec}`
    case "show":
      return `git show --no-ext-diff --no-color --format=fuller ${quoteShellArgument(revision ?? "HEAD")}${pathspec}`
    case "log":
      return `git log --no-color --decorate=short -n ${limit ?? 30}${revision ? ` ${quoteShellArgument(revision)}` : ""}${pathspec}`
    case "blame":
      return `git blame --no-color${revision ? ` ${quoteShellArgument(revision)}` : ""} -- ${quoteShellArgument(path!)}`
  }
}

export const gitInspectTool: ToolDef<GitInspectArgs> = {
  name: "GitInspect",
  searchHint: "read-only git status diff show log blame repository inspection",
  description:
    "Inspect Git state without exposing an arbitrary shell. Supports only status, diff, show, log, and blame with validated revision/path arguments.",
  parameters: schema,
  readOnly: true,
  modes: ["review"],

  async execute(args, ctx: ToolContext) {
    const command = buildCommand(args)
    const result = await ctx.host.runCommand(command, ctx.cwd, ctx.signal)
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    return {
      success: result.exitCode === 0,
      output: output || (result.exitCode === 0 ? "(no output)" : `Git exited with code ${result.exitCode}`),
      metadata: {
        operation: args.operation,
        exitCode: result.exitCode,
      },
    }
  },
}
