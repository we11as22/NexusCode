/**
 * Optional sink for indexing diagnostics (Roo-style telemetry hooks without bundling a telemetry SDK).
 */

export type IndexTelemetryPayload = Record<string, unknown>

let sink: ((event: string, payload?: IndexTelemetryPayload) => void) | undefined

export function setIndexTelemetrySink(
  fn: ((event: string, payload?: IndexTelemetryPayload) => void) | undefined,
): void {
  sink = fn
}

export function captureIndexTelemetry(event: string, payload?: IndexTelemetryPayload): void {
  try {
    sink?.(event, payload)
  } catch {
    /* */
  }
}
