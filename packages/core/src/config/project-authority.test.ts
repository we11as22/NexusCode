import { describe, expect, it } from "vitest"

import {
  createPendingProjectAuthorityRequest,
} from "./project-authority.js"

describe("project authority request bounds", () => {
  it("rejects oversized arrays and serialized payloads", () => {
    expect(() =>
      createPendingProjectAuthorityRequest("remote-skills", {
        skillsUrls: Array.from(
          { length: 257 },
          (_, index) => `https://skills.test/${index}`,
        ),
      }),
    ).toThrow()

    expect(() =>
      createPendingProjectAuthorityRequest("custom-tools", {
        tools: {
          custom: Array.from(
            { length: 129 },
            (_, index) => `.nexus/tools-${index}`,
          ),
        },
      }),
    ).toThrow()

    expect(() =>
      createPendingProjectAuthorityRequest("model-endpoint", {
        model: {
          extra: {
            metadata: "x".repeat(70_000),
          },
        },
      }),
    ).toThrow(/size limit/u)
  })

  it("rejects cyclic or pathologically deep payload values deterministically", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic

    expect(() =>
      createPendingProjectAuthorityRequest("model-endpoint", {
        model: { extra: cyclic },
      }),
    ).toThrow(/cyclic/u)

    let deep: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) {
      deep = { child: deep }
    }
    expect(() =>
      createPendingProjectAuthorityRequest("model-endpoint", {
        model: { extra: deep },
      }),
    ).toThrow(/depth/u)
  })
})
