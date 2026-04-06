import type { Key, RenderOptions } from 'ink'

export type ExtendedKey = Key & Partial<{
  backtab: boolean
  home: boolean
  end: boolean
  fn: boolean
}>

export type RenderOptionsWithFlicker = RenderOptions & {
  onFlicker?: () => void
}

export function asExtendedKey(key: Key): ExtendedKey {
  return key as ExtendedKey
}
