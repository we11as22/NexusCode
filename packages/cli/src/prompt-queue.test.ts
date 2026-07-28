import { describe, expect, it } from "vitest"

import {
  enqueuePrompt,
  popLastPrompt,
  shiftPrompt,
  type QueuedPrompt,
} from "./prompt-queue.js"

function prompt(text: string): QueuedPrompt {
  return {
    id: text,
    text,
    mode: "prompt",
    pastedText: null,
    pastedImage: null,
    isSubmittingSlashCommand: false,
  }
}

describe("CLI prompt queue", () => {
  it("dispatches queued prompts in FIFO order", () => {
    const queue = enqueuePrompt(
      enqueuePrompt([], prompt("first")),
      prompt("second"),
    )

    const first = shiftPrompt(queue)
    expect(first.item?.text).toBe("first")
    expect(first.queue.map((item) => item.text)).toEqual(["second"])
  })

  it("keeps paste payloads with the prompt that captured them", () => {
    const queued: QueuedPrompt = {
      ...prompt("with paste"),
      pastedText: "original pasted text",
      pastedImage: "/tmp/image.png",
    }

    expect(shiftPrompt(enqueuePrompt([], queued)).item).toEqual(queued)
  })

  it("does not mutate the existing queue", () => {
    const original = [prompt("first")]
    const next = enqueuePrompt(original, prompt("second"))

    expect(original.map((item) => item.text)).toEqual(["first"])
    expect(next.map((item) => item.text)).toEqual(["first", "second"])
  })

  it("recalls the latest queued prompt without disturbing earlier items", () => {
    const result = popLastPrompt([prompt("first"), prompt("second")])

    expect(result.item?.text).toBe("second")
    expect(result.queue.map((item) => item.text)).toEqual(["first"])
  })
})
