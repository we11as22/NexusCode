export type StateInputValue =
  | null
  | number
  | bigint
  | string
  | NodeJS.ArrayBufferView

export type StateOutputValue =
  | null
  | number
  | bigint
  | string
  | Uint8Array

export interface StateRunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface StateConnection {
  exec(sql: string): void
  run(
    sql: string,
    parameters?: readonly StateInputValue[],
  ): StateRunResult
  get<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters?: readonly StateInputValue[],
  ): T | undefined
  all<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters?: readonly StateInputValue[],
  ): T[]
  pragma(name: string): StateOutputValue
  userVersion(): number
}

export interface NexusStateDatabaseOptions {
  path: string
  processId?: string
  now?: () => number
}

export type IntegrityCheckResult =
  | { ok: true }
  | { ok: false; messages: string[] }
