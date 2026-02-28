# Max Mode Reframed, OpenRouter Aliased, Subagent Telemetry, and Vector Batching

**Date:** 2026-02-28
**Type:** architecture / feature / invariant

## What Changed

NexusCode now treats `maxMode` as an execution strategy, not an alternate provider/model. The config shape was changed to:

- `maxMode.enabled`
- `maxMode.tokenBudgetMultiplier`

Agent execution uses the same `model` provider/id in all modes and only increases token budget while preserving existing prompts and safety logic.

OpenRouter is no longer a first-class LLM provider in schema/runtime routing. Instead, OpenRouter is normalized as OpenAI-compatible (`provider: openai-compatible` + `baseUrl: https://openrouter.ai/api/v1`) with compatibility mapping for legacy configs and overrides.

Subagent lifecycle events were added and wired end-to-end:

- `subagent_start`
- `subagent_tool_start`
- `subagent_tool_end`
- `subagent_done`

Both CLI TUI and VSCode webview now render subagents as dedicated boxes/cards with task, mode, status, and current tool.

Vector indexing was hardened with embedding batching + controlled parallelism:

- `indexing.embeddingBatchSize` (default 60)
- `indexing.embeddingConcurrency` (default 2)

These are applied in vector upsert paths to reduce provider errors from oversized requests while preserving throughput.

## Why

The previous `maxMode` semantics created an implicit provider/model switch that conflicted with expected behavior. Users need a deterministic “same model, deeper reasoning” mode.

Treating OpenRouter as OpenAI-compatible simplifies provider mental model, aligns API behavior, and keeps backward compatibility through normalization.

Subagent transparency is required for multi-agent trust and operability in both terminal and extension UX.

Embedding providers can fail on large payloads or high request pressure; batching/concurrency controls improve stability on real codebases.

## What This Replaces

- `maxMode` as a provider-specific override (`provider/id/temperature`)
- OpenRouter as a separate primary provider branch
- Opaque subagent execution (no dedicated live UI cards)
- Single-shot large embedding upserts without explicit batching controls

## Watch Out For

Legacy config files may still contain:

- `model.provider: openrouter`
- `maxMode.provider/id`

These are normalized/ignored at load time, but writing configs from updated UI/CLI will use the new canonical shapes.

Without valid embedding credentials, vector upsert/search now degrades gracefully and logs concise warnings while FTS indexing remains operational.
