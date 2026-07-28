import { describe, expect, it } from "vitest"

import type { RuntimeTaskActivity } from "../stores/chat.js"
import { selectVisibleRuntimeTasks } from "./RuntimeActivityPanel.js"

function task(
  id: string,
  status: RuntimeTaskActivity["status"],
): RuntimeTaskActivity {
  return {
    id,
    kind: "agent",
    subject: id,
    status,
    updatedAt: 1,
  }
}

describe("selectVisibleRuntimeTasks", () => {
  it("keeps only work that is still live", () => {
    const visible = selectVisibleRuntimeTasks([
      task("pending", "pending"),
      task("in-progress", "in_progress"),
      task("running", "running"),
      task("completed", "completed"),
      task("failed", "failed"),
      task("killed", "killed"),
      task("cancelled", "cancelled"),
      task("deleted", "deleted"),
    ])

    expect(visible.map(({ id }) => id)).toEqual([
      "pending",
      "in-progress",
      "running",
    ])
  })
})
