import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  collectFeatureCensus,
  renderFeatureCensus,
} from "./feature-census.mjs"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-census-"))
  const files = {
    "docs/features.md": "# Features\n\n## AlphaTool\n\n## MissingTool\n",
    "packages/core/src/tools/built-in/alpha.ts": `
      export const alphaTool = {
        name: "AlphaTool",
        async execute() {},
      }
    `,
    "packages/core/src/tools/built-in/index.ts": `
      import { alphaTool } from "./alpha.js"
      export function getAllBuiltinTools() { return [alphaTool] }
    `,
    "packages/core/src/agent/modes.ts": `
      export const TOOL_GROUP_MEMBERS = { read: ["AlphaTool"] }
    `,
    "packages/core/src/types.ts": `
      export type AgentEvent = { type: "registered_event"; value: string }
    `,
    "packages/core/src/alpha.test.ts": `
      test("AlphaTool is reachable", () => {})
    `,
    "packages/vscode/package.json": JSON.stringify({
      contributes: {
        configuration: {
          properties: {
            "nexuscode.orphanSetting": { type: "boolean", default: false },
          },
        },
      },
    }),
    "packages/cli/src/nexus-query.ts": "const rendered = 'other_event'",
    "packages/vscode/src/controller.ts": "const rendered = 'other_event'",
    "packages/server/src/routes/session.ts": "const transport = 'ndjson'",
  }

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

test("classifies linked evidence and static gaps without claiming runtime success", async () => {
  const root = await fixture()
  try {
    const rows = await collectFeatureCensus(root)
    const byFeature = new Map(rows.map((row) => [row.feature, row]))

    assert.equal(byFeature.get("tool:AlphaTool")?.status, "working-evidence")
    assert.equal(byFeature.get("tool:MissingTool")?.status, "documentation-only")
    assert.equal(
      byFeature.get("event:registered_event")?.status,
      "surface-gap",
    )
    assert.equal(
      byFeature.get("setting:nexuscode.orphanSetting")?.status,
      "orphan-setting",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("renders a deterministic report with the complete evidence columns", async () => {
  const root = await fixture()
  try {
    const first = renderFeatureCensus(await collectFeatureCensus(root))
    const second = renderFeatureCensus(await collectFeatureCensus(root))

    assert.equal(first, second)
    assert.match(
      first,
      /\| feature \| declared \| registered \| mode-visible \| executed-by \| persisted-by \| rendered-cli \| rendered-vscode \| rendered-server \| tests \| status \|/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
