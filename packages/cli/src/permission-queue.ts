export type PermissionQueueItem = {
  requestId: string
}

export function enqueuePermissionRequest<T extends PermissionQueueItem>(
  queue: readonly T[],
  request: T,
): T[] {
  if (queue.some((item) => item.requestId === request.requestId)) {
    return [...queue]
  }
  return [...queue, request]
}

export function removePermissionRequest<T extends PermissionQueueItem>(
  queue: readonly T[],
  requestId: string,
): T[] {
  return queue.filter((item) => item.requestId !== requestId)
}
