import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  readCheckpointEntries,
  writeCheckpointEntries,
} from "./storage.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

describe("checkpoint storage", () => {
  it("serializes concurrent session updates without dropping another session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-checkpoints-"))
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    roots.push(root)

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeCheckpointEntries(
          cwd,
          `session_${index}`,
          [{
            hash: `hash_${index}`,
            ts: index,
            messageId: `message_${index}`,
          }],
          { homeDir },
        ),
      ),
    )

    await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        await expect(
          readCheckpointEntries(
            cwd,
            `session_${index}`,
            { homeDir },
          ),
        ).resolves.toEqual([{
          hash: `hash_${index}`,
          ts: index,
          messageId: `message_${index}`,
        }])
      }),
    )
  })
})
