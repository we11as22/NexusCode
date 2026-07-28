export interface QueuedPrompt {
  id: string
  text: string
  mode: "bash" | "prompt"
  /** Agent mode captured when the user queued this prompt. */
  nexusMode?: string
  pastedText: string | null
  pastedImage: string | null
  isSubmittingSlashCommand: boolean
}

export function enqueuePrompt(
  queue: readonly QueuedPrompt[],
  item: QueuedPrompt,
): QueuedPrompt[] {
  return [...queue, item]
}

export function shiftPrompt(queue: readonly QueuedPrompt[]): {
  item: QueuedPrompt | undefined
  queue: QueuedPrompt[]
} {
  return {
    item: queue[0],
    queue: queue.slice(1),
  }
}

export function popLastPrompt(queue: readonly QueuedPrompt[]): {
  item: QueuedPrompt | undefined
  queue: QueuedPrompt[]
} {
  return {
    item: queue.at(-1),
    queue: queue.slice(0, -1),
  }
}
