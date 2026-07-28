import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  FileChangeSetStore,
} from "../../changes/file-store.js"
import { hashFileContent } from "../../changes/hash.js"
import {
  ChangeSetService,
  FileMutationConflictError,
} from "../../changes/service.js"
import type {
  CapturedFileState,
  HostFileMutation,
} from "../../changes/types.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { applyPatchTool } from "../../tools/built-in/apply-patch.js"
import { editTool } from "../../tools/built-in/replace-in-file.js"
import { writeFileTool } from "../../tools/built-in/write-file.js"
import { buildDurableChangeHunks } from "../../tools/file-change-flow.js"
import { createNexusRunServices } from "../run-services.js"
import { executeToolPipeline } from "../tool-pipeline.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

function absent(): CapturedFileState {
  return { exists: false, content: null, mode: null }
}

function present(content: string): CapturedFileState {
  return {
    exists: true,
    content: Buffer.from(content),
    mode: 0o644,
  }
}

function cloneState(state: CapturedFileState): CapturedFileState {
  return state.exists
    ? {
        exists: true,
        content: Buffer.from(state.content),
        mode: state.mode,
      }
    : absent()
}

async function harness(options: {
  initial?: string
  initialFiles?: Readonly<Record<string, string>>
  approve?: (mutate: (content: string) => void) => boolean
  failMutationPathOnce?: string
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-change-tools-"))
  roots.push(root)
  const states = new Map<string, CapturedFileState>()
  if (options.initial !== undefined) {
    states.set("file.ts", present(options.initial))
  }
  for (const [filePath, content] of Object.entries(
    options.initialFiles ?? {},
  )) {
    states.set(filePath, present(content))
  }
  const approvals: unknown[] = []
  let failedMutation = false
  const set = (content: string) => {
    states.set("file.ts", present(content))
  }
  const host = createFakeHost({
    cwd: root,
    async readFile(filePath) {
      const state = states.get(filePath) ?? absent()
      if (!state.exists) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return Buffer.from(state.content).toString("utf8")
    },
    async exists(filePath) {
      return (states.get(filePath) ?? absent()).exists
    },
    async readFileState(filePath) {
      return cloneState(states.get(filePath) ?? absent())
    },
    async applyFileMutation(mutation: HostFileMutation) {
      if (
        !failedMutation &&
        mutation.path === options.failMutationPathOnce
      ) {
        failedMutation = true
        throw new Error(`simulated write failure: ${mutation.path}`)
      }
      const current = states.get(mutation.path) ?? absent()
      const actualHash = current.exists
        ? hashFileContent(current.content).hash
        : null
      if (
        current.exists !== mutation.expected.exists ||
        actualHash !== mutation.expected.hash ||
        current.mode !== mutation.expected.mode
      ) {
        throw new FileMutationConflictError(mutation.path)
      }
      states.set(
        mutation.path,
        mutation.next.exists
          ? {
              exists: true,
              content: Buffer.from(mutation.next.content),
              mode: mutation.next.mode,
            }
          : absent(),
      )
    },
    async showApprovalDialog(action) {
      approvals.push(action)
      return {
        approved: options.approve ? options.approve(set) : true,
      }
    },
  })
  const session = createFakeSession(root)
  const store = new FileChangeSetStore("workspace-test", { rootDir: root })
  const service = new ChangeSetService({
    workspaceId: "workspace-test",
    store,
    files: {
      readFileState: (filePath) => host.readFileState!(filePath),
      applyFileMutation: (mutation) => host.applyFileMutation!(mutation),
    },
  })
  const context = (toolCallId: string): ToolContext => ({
    cwd: root,
    host,
    session,
    config: createTestConfig(),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
    partId: `part-${toolCallId}`,
    toolExecutionMessageId: "message-1",
    executionIdentity: {
      workspaceId: "workspace-test",
      sessionId: session.id,
      turnId: "turn-1",
      runId: "run-1",
      messageId: "message-1",
      partId: `part-${toolCallId}`,
      toolCallId,
    },
    changeSetService: service,
  })
  return { context, host, service, states, store, approvals }
}

describe("Write/Edit/ApplyPatch durable change-set integration", () => {
  it("fails Write and Edit closed when durable mutation authority is absent", async () => {
    const cwd = process.cwd()
    const writes: string[] = []
    const host = createFakeHost({
      cwd,
      async writeFile(filePath) {
        writes.push(filePath)
      },
      async readFile() {
        return "before\n"
      },
    })
    const context: ToolContext = {
      cwd,
      host,
      session: createFakeSession(cwd),
      config: createTestConfig(),
      services: createNexusRunServices(),
      mode: "agent",
      signal: new AbortController().signal,
    }

    await expect(writeFileTool.execute({
      file_path: "file.ts",
      content: "after\n",
    }, context)).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/durable ChangeSet support is required/i),
    })
    await expect(editTool.execute({
      file_path: "file.ts",
      old_string: "before",
      new_string: "after",
    }, context)).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/durable ChangeSet support is required/i),
    })
    expect(writes).toEqual([])
  })

  it("rejects a non-unique exact replacement unless replace_all is explicit", async () => {
    const { context, host } = await harness({
      initial: "same\nmiddle\nsame\n",
    })

    await expect(editTool.execute({
      file_path: "file.ts",
      old_string: "same",
      new_string: "changed",
    }, context("edit-non-unique"))).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/not unique|2 occurrences/i),
    })
    expect(host.approvals).toEqual([])
  })

  it("persists, exactly approves, and applies a Write proposal", async () => {
    const { approvals, context, service, states } = await harness()

    const result = await writeFileTool.execute({
      file_path: "file.ts",
      content: "created\n",
    }, context("write-1"))

    expect(result).toMatchObject({
      success: true,
      metadata: {
        changeSetId: expect.any(String),
        proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        changeSetState: "applied",
      },
    })
    expect(states.get("file.ts")).toEqual(present("created\n"))
    expect(approvals).toEqual([
      expect.objectContaining({
        type: "write",
        tool: "Write",
        path: "file.ts",
        content: "created\n",
      }),
    ])
    await expect(
      service.get(String(result.metadata?.changeSetId)),
    ).resolves.toMatchObject({
      state: "applied",
      identity: { toolCallId: "write-1" },
      files: [{
        hunks: [expect.objectContaining({
          oldLines: 0,
          newLines: 1,
        })],
      }],
    })
  })

  it("durably rejects a denied Edit without changing bytes", async () => {
    const { context, service, states } = await harness({
      initial: "before\n",
      approve: () => false,
    })

    const result = await editTool.execute({
      file_path: "file.ts",
      old_string: "before",
      new_string: "after",
    }, context("edit-denied"))

    expect(result).toMatchObject({
      success: false,
      metadata: {
        changeSetId: expect.any(String),
        changeSetState: "rejected",
      },
    })
    expect(states.get("file.ts")).toEqual(present("before\n"))
    await expect(
      service.get(String(result.metadata?.changeSetId)),
    ).resolves.toMatchObject({ state: "rejected" })
  })

  it("fails closed when bytes drift while exact approval is pending", async () => {
    const { context, service, states } = await harness({
      initial: "before\n",
      approve(set) {
        set("manual\n")
        return true
      },
    })

    const result = await editTool.execute({
      file_path: "file.ts",
      old_string: "before",
      new_string: "after",
    }, context("edit-drift"))

    expect(result).toMatchObject({
      success: false,
      metadata: {
        changeSetId: expect.any(String),
        changeSetState: "conflicted",
      },
    })
    expect(states.get("file.ts")).toEqual(present("manual\n"))
    await expect(
      service.get(String(result.metadata?.changeSetId)),
    ).resolves.toMatchObject({ state: "conflicted" })
  })

  it("coalesces repeated same-turn Edit calls to the earliest before-state", async () => {
    const { context, service, states } = await harness({
      initial: "one\n",
    })

    const first = await editTool.execute({
      file_path: "file.ts",
      old_string: "one",
      new_string: "two",
    }, context("edit-1"))
    const second = await editTool.execute({
      file_path: "file.ts",
      old_string: "two",
      new_string: "three",
    }, context("edit-2"))

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(states.get("file.ts")).toEqual(present("three\n"))
    const effective = await service.listEffectiveApplied({
      sessionId: context("read").session.id,
      turnId: "turn-1",
    })
    expect(effective).toHaveLength(1)
    expect(effective[0]?.files[0]?.before.hash).toBe(
      hashFileContent("one\n").hash,
    )
  })

  it("recovers an interrupted applying record before retrying the same tool call", async () => {
    const { context, service, states, store } = await harness({
      initial: "before\n",
    })
    const ctx = context("write-retry")
    const proposed = await service.propose({
      identity: ctx.executionIdentity!,
      files: [{
        path: "file.ts",
        after: {
          exists: true,
          content: "after\n",
          mode: 0o644,
        },
        hunks: buildDurableChangeHunks("before\n", "after\n"),
        binary: false,
      }],
    })
    const approved = await service.approve(
      proposed.id,
      proposed.proposalHash,
    )
    await store.replace(
      {
        ...approved,
        state: "applying",
        revision: approved.revision + 1,
      },
      approved.revision,
    )

    const result = await writeFileTool.execute({
      file_path: "file.ts",
      content: "after\n",
    }, ctx)

    expect(result).toMatchObject({
      success: true,
      metadata: {
        changeSetId: proposed.id,
        changeSetState: "applied",
      },
    })
    expect(states.get("file.ts")).toEqual(present("after\n"))
  })

  it("applies a multi-file patch as one exactly approved change set", async () => {
    const { context, service, states, approvals } = await harness({
      initialFiles: {
        "src/current.ts": "export const current = 1\n",
        "src/remove.ts": "remove me\n",
      },
    })

    const result = await applyPatchTool.execute({
      patch: `*** Begin Patch
*** Add File: src/new.ts
+export const added = true
*** Update File: src/current.ts
@@
-export const current = 1
+export const current = 2
*** Delete File: src/remove.ts
*** End Patch`,
    }, {
      ...context("patch-1"),
      fileEditApproval: {
        required: true,
        permissionRule: false,
      },
    })

    expect(result).toMatchObject({
      success: true,
      metadata: {
        changeSetId: expect.any(String),
        changeSetState: "applied",
        changeFiles: [
          {
            path: "src/new.ts",
            operation: "create",
            diffStats: { added: 1, removed: 0 },
            diffHunks: [
              {
                type: "add",
                lineNum: 1,
                line: "export const added = true",
              },
            ],
          },
          {
            path: "src/current.ts",
            operation: "modify",
            diffStats: { added: 1, removed: 1 },
            diffHunks: [
              {
                type: "remove",
                lineNum: 1,
                line: "export const current = 1",
              },
              {
                type: "add",
                lineNum: 1,
                line: "export const current = 2",
              },
            ],
          },
          {
            path: "src/remove.ts",
            operation: "delete",
            diffStats: { added: 0, removed: 1 },
            diffHunks: [
              {
                type: "remove",
                lineNum: 1,
                line: "remove me",
              },
            ],
          },
        ],
      },
    })
    expect(approvals).toHaveLength(1)
    expect(states.get("src/new.ts")).toEqual(
      present("export const added = true\n"),
    )
    expect(states.get("src/current.ts")).toEqual(
      present("export const current = 2\n"),
    )
    expect(states.get("src/remove.ts")).toEqual(absent())
    await expect(
      service.get(String(result.metadata?.changeSetId)),
    ).resolves.toMatchObject({
      identity: { toolCallId: "patch-1" },
      state: "applied",
      files: { length: 3 },
    })
  })

  it("compensates an interrupted multi-file patch and reports failure", async () => {
    const { context, states } = await harness({
      initialFiles: {
        "a.ts": "before a\n",
        "b.ts": "before b\n",
      },
      failMutationPathOnce: "b.ts",
    })

    const result = await applyPatchTool.execute({
      patch: `*** Begin Patch
*** Update File: a.ts
@@
-before a
+after a
*** Update File: b.ts
@@
-before b
+after b
*** End Patch`,
    }, {
      ...context("patch-partial"),
      fileEditApproval: {
        required: false,
        permissionRule: false,
      },
    })

    expect(result.success).toBe(false)
    expect(states.get("a.ts")).toEqual(present("before a\n"))
    expect(states.get("b.ts")).toEqual(present("before b\n"))
  })

  it("enforces path deny rules for every file before proposing a patch", async () => {
    const { context, states, approvals } = await harness({
      initialFiles: {
        "src/allowed.ts": "allowed\n",
        "secrets/blocked.ts": "blocked\n",
      },
    })
    const ctx = context("patch-denied")
    ctx.config.permissions.denyPatterns = ["secrets/**"]

    const result = await executeToolPipeline(
      {
        callId: "patch-denied",
        messageId: "message-1",
        partId: "part-patch-denied",
        toolName: "ApplyPatch",
        input: {
          patch: `*** Begin Patch
*** Update File: src/allowed.ts
@@
-allowed
+changed
*** Update File: secrets/blocked.ts
@@
-blocked
+leaked
*** End Patch`,
        },
        origin: "native",
      },
      {
        tools: [applyPatchTool],
        context: ctx,
        autoApproveActions: new Set(),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result).toMatchObject({
      success: false,
      output: expect.stringContaining("secrets/**"),
    })
    expect(approvals).toEqual([])
    expect(states.get("src/allowed.ts")).toEqual(present("allowed\n"))
    expect(states.get("secrets/blocked.ts")).toEqual(
      present("blocked\n"),
    )
  })
})
