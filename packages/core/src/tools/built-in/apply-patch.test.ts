import { describe, expect, it } from "vitest"

import {
  applyPatchChunksToText,
  extractApplyPatchPaths,
  parseApplyPatch,
} from "./apply-patch.js"

describe("Codex-style apply_patch parser", () => {
  it("strictly parses add, update, move, and delete operations", () => {
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: src/new.ts
+export const added = true
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@ function value()
-  return 1
+  return 2
*** Delete File: src/remove.ts
*** End Patch`)

    expect(patch.operations).toEqual([
      {
        type: "add",
        path: "src/new.ts",
        content: "export const added = true\n",
      },
      {
        type: "update",
        path: "src/old.ts",
        movePath: "src/moved.ts",
        chunks: [{
          changeContext: "function value()",
          oldLines: ["  return 1"],
          newLines: ["  return 2"],
          endOfFile: false,
        }],
      },
      {
        type: "delete",
        path: "src/remove.ts",
      },
    ])
    expect(extractApplyPatchPaths(patch.raw)).toEqual([
      "src/new.ts",
      "src/old.ts",
      "src/moved.ts",
      "src/remove.ts",
    ])
  })

  it("rejects ignored junk instead of silently applying a partial patch", () => {
    expect(() => parseApplyPatch(`*** Begin Patch
this line must not be ignored
*** Add File: ok.ts
+ok
*** End Patch`)).toThrow(/invalid hunk header.*line 2/i)
  })

  it("rejects empty and malformed file operations", () => {
    expect(() => parseApplyPatch(`*** Begin Patch
*** Add File: empty.ts
*** End Patch`)).toThrow(/requires at least one .* line/i)
    expect(() => parseApplyPatch(`*** Begin Patch
*** Update File: empty.ts
*** End Patch`)).toThrow(/empty update/i)
  })
})

describe("apply_patch text transformation", () => {
  it("applies ordered exact chunks and preserves CRLF, BOM, and final newline", () => {
    const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: src/file.ts
@@ function value()
-  return 1
+  return 2
@@
-const end = false
+const end = true
*** End Patch`)
    const update = parsed.operations[0]
    if (update?.type !== "update") throw new Error("expected update")

    expect(applyPatchChunksToText(
      "\uFEFFfunction value()\r\n  return 1\r\nconst end = false\r\n",
      update.chunks,
      update.path,
    )).toBe(
      "\uFEFFfunction value()\r\n  return 2\r\nconst end = true\r\n",
    )
  })

  it("fails closed when an exact sequence is ambiguous", () => {
    const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: repeated.txt
@@
-same
+changed
*** End Patch`)
    const update = parsed.operations[0]
    if (update?.type !== "update") throw new Error("expected update")

    expect(() => applyPatchChunksToText(
      "same\nmiddle\nsame\n",
      update.chunks,
      update.path,
    )).toThrow(/ambiguous/i)
  })
})
