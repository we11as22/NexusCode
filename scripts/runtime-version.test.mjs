import test from "node:test"
import assert from "node:assert/strict"
import { validateRuntimeVersion } from "./runtime-version.mjs"

test("accepts the pinned Node release", () => {
  assert.deepEqual(validateRuntimeVersion("20.19.2"), { ok: true })
})

test("rejects Node 18, older Node 20, and a different major", () => {
  for (const version of ["18.20.8", "20.18.3", "21.7.3", "22.0.0", "25.8.1"]) {
    const result = validateRuntimeVersion(version)
    assert.equal(result.ok, false)
    assert.match(result.message, /Node\.js 20\.19\.2/)
  }
})
