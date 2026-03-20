import type { Message } from "../query.js"

export type SerializedMessage = Message & {
  timestamp?: string
  cwd?: string
  userType?: string
  sessionId?: string
  version?: string
}

export type LogOption = {
  date: string
  forkNumber?: number
  fullPath: string
  messages: SerializedMessage[]
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  sidechainNumber?: number
}

export type LogListProps = {
  context: { unmount?: () => void }
}
