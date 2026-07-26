import test from "node:test"
import assert from "node:assert/strict"
import { buildOptionalContextMode } from "./build-optional-context-mode.mjs"

test("skips the optional context-mode build when its source is absent", async () => {
  let runs = 0
  const result = await buildOptionalContextMode({
    sourceExists: false,
    run: async () => {
      runs += 1
    },
  })

  assert.deepEqual(result, { status: "skipped" })
  assert.equal(runs, 0)
})

test("propagates an optional context-mode build failure when its source exists", async () => {
  await assert.rejects(
    buildOptionalContextMode({
      sourceExists: true,
      run: async () => {
        throw new Error("context build failed")
      },
    }),
    /context build failed/,
  )
})

test("runs the optional context-mode build when its source exists", async () => {
  let runs = 0
  const result = await buildOptionalContextMode({
    sourceExists: true,
    run: async () => {
      runs += 1
    },
  })

  assert.deepEqual(result, { status: "built" })
  assert.equal(runs, 1)
})
