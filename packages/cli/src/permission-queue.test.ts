import { describe, expect, it } from "vitest"

import {
  enqueuePermissionRequest,
  removePermissionRequest,
} from "./permission-queue.js"

type Request = {
  requestId: string
  file: string
}

describe("CLI permission queue", () => {
  it("keeps concurrent requests in FIFO order without replacing the visible diff", () => {
    const first = { requestId: "write-1", file: "first.ts" }
    const second = { requestId: "write-2", file: "second.ts" }

    const queued = enqueuePermissionRequest(
      enqueuePermissionRequest<Request>([], first),
      second,
    )

    expect(queued).toEqual([first, second])
    expect(queued[0]).toBe(first)
  })

  it("deduplicates replayed requests and removes only the completed request", () => {
    const first = { requestId: "write-1", file: "first.ts" }
    const second = { requestId: "write-2", file: "second.ts" }
    const queued = enqueuePermissionRequest(
      enqueuePermissionRequest(
        enqueuePermissionRequest<Request>([], first),
        first,
      ),
      second,
    )

    expect(queued).toEqual([first, second])
    expect(removePermissionRequest(queued, first.requestId)).toEqual([second])
  })
})
