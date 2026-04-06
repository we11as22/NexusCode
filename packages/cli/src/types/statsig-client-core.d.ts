declare module '@statsig/client-core' {
  export interface StorageProvider {
    isReady(): boolean
    isReadyResolver(): Promise<void> | null
    getProviderName(): string
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
    getAllKeys(): readonly string[]
  }
}
