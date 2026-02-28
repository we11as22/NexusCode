# CLI Loop + Vector Reindex Hardening

**Date:** 2026-02-28
**Type:** architecture

## What Changed

NexusCode runtime was hardened in four critical areas:

1. Agent loop now stops after non-retry stream errors instead of re-entering endless outer-loop retries (notably in `ask` mode when model repeatedly calls unavailable tools).
2. Non-interactive CLI (`--print`) now wires the same advanced capabilities as interactive mode: MCP tools, `spawn_agent`, optional indexer, and max-mode client routing.
3. Vector indexing now auto-detects embedding dimension from the provider response and recreates mismatched Qdrant collections when needed.
4. Full `reindex()` now clears vector collection state too, and vector backfill runs for unchanged files when vector search is enabled on top of an existing FTS index.
5. Plan-mode write policy is now enforced consistently across `write_to_file`, `replace_in_file`, and `apply_patch`: writes are allowed only under `.nexus/plans/*.md|*.txt`.

## Why

Validation on `/root/asudakov/projects/nexuscode_test` revealed functional regressions that affected reliability and feature parity:

- repeated unavailable-tool loops in `ask`,
- missing `spawn_agent` and indexing path in `--print`,
- empty/partial vector collections after toggling semantic index,
- stale vector points after full reindex.
- plan-mode write policy bypass risk via non-path patch operations.

These failures directly impacted promised behavior across modes and settings.

## What This Replaces

- Retry-prone error loop behavior in `runAgentLoop` after fatal stream errors.
- Reduced capability surface in CLI non-interactive branch.
- Fixed-dimension-only vector collection initialization and FTS-only unchanged-file skip during vector backfill.
- Reindex flow that reset FTS but could leave stale vector data.

## Watch Out For

- Existing Qdrant collections may be recreated if stored vector size does not match live embeddings output.
- First vector-enabled run may take longer due dimension probe and one-time backfill.
- `--no-index` behavior in CLI now relies on yargs `index` option semantics (`--no-index` disables).

## Related

- `packages/core/src/agent/loop.ts`
- `packages/core/src/indexer/index.ts`
- `packages/core/src/indexer/vector.ts`
- `packages/core/src/provider/embeddings.ts`
- `packages/core/src/agent/parallel.ts`
- `packages/cli/src/index.ts`
