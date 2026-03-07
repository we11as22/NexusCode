/**
 * Stub: no-op Sentry for NexusCode CLI (no telemetry).
 */
export function initSentry(): void {
  // no-op
}

export async function captureException(_error: unknown): Promise<void> {
  // no-op
}
