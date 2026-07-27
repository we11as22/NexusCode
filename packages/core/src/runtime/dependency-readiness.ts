function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one optional turn dependency without silently changing the
 * capability set. A deadline or loader failure is always surfaced to the
 * owning UI/transport before the explicit fallback is returned.
 */
export async function settleRuntimeDependency<T>(
  label: string,
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onDiagnostic: (message: string) => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ type: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ type: "timeout" }), timeoutMs)
    timeout.unref?.()
  })
  try {
    const result = await Promise.race([
      work.then(
        (value) => ({ type: "ok" as const, value }),
        (error) => ({ type: "error" as const, error }),
      ),
      deadline,
    ])
    if (result.type === "ok") return result.value
    if (result.type === "timeout") {
      onDiagnostic(
        `[${label} runtime] loading timed out after ${timeoutMs}ms; continuing without it`,
      )
      return fallback
    }
    onDiagnostic(
      `[${label} runtime] ${errorMessage(result.error)}; continuing without it`,
    )
    return fallback
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
