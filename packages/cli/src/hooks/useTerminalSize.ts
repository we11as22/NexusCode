import { useSyncExternalStore } from 'react'

type TerminalSize = { columns: number; rows: number }

function readTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}

let currentSize: TerminalSize = readTerminalSize()
const subscribers = new Set<() => void>()
let resizeListenerAttached = false

function onResize() {
  currentSize = readTerminalSize()
  for (const cb of subscribers) cb()
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)

  if (!resizeListenerAttached) {
    process.stdout.on('resize', onResize)
    resizeListenerAttached = true
  }

  return () => {
    subscribers.delete(onStoreChange)
    if (resizeListenerAttached && subscribers.size === 0) {
      process.stdout.off('resize', onResize)
      resizeListenerAttached = false
    }
  }
}

function getSnapshot(): TerminalSize {
  return currentSize
}

export function useTerminalSize(): TerminalSize {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
