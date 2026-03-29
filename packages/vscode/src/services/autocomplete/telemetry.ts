/**
 * NexusCode: autocomplete telemetry shim (no-op). Kilo forwarded events to a proxy.
 */

export enum TelemetryEventName {
  GHOST_SERVICE_DISABLED = "ghost_service_disabled",
  INLINE_ASSIST_AUTO_TASK = "inline_assist_auto_task",
  AUTOCOMPLETE_SUGGESTION_REQUESTED = "autocomplete_suggestion_requested",
  AUTOCOMPLETE_SUGGESTION_FILTERED = "autocomplete_suggestion_filtered",
  AUTOCOMPLETE_SUGGESTION_CACHE_HIT = "autocomplete_suggestion_cache_hit",
  AUTOCOMPLETE_LLM_SUGGESTION_RETURNED = "autocomplete_llm_suggestion_returned",
  AUTOCOMPLETE_LLM_REQUEST_COMPLETED = "autocomplete_llm_request_completed",
  AUTOCOMPLETE_LLM_REQUEST_FAILED = "autocomplete_llm_request_failed",
  AUTOCOMPLETE_ACCEPT_SUGGESTION = "autocomplete_accept_suggestion",
  AUTOCOMPLETE_UNIQUE_SUGGESTION_SHOWN = "autocomplete_unique_suggestion_shown",
}

export const TelemetryProxy = {
  capture(_event: TelemetryEventName, _props?: Record<string, unknown>): void {
    // intentionally empty — wire to your analytics if needed
  },
}
