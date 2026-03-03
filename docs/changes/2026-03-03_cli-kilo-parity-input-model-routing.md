# CLI: Kilo-parity input fixes, model routing, and free LLM reliability

**Date:** 2026-03-03
**Type:** fix

## What Changed

- Reworked TUI keyboard text ingestion in `packages/cli/src/tui/App.tsx` to use `evt.sequence` instead of one-char `evt.name` only.
  - Fixed lost spaces and broken paste chunks in chat/model/settings fields.
  - Normalized single-line fields to prevent cursor dropping onto the next line from pasted CR/LF.
  - Added width-aware clipping/padding helpers for stable menu/list alignment.
- Updated copy/abort behavior:
  - `Ctrl+C` now prioritizes copying selected text (if any) and does not immediately quit in that case.
  - Existing abort behavior for running requests remains unchanged.
- Updated UI parity details:
  - Home logo switched to blue Nexus branding (`Nexus CLI` fallback + blue ASCII logo).
  - Agent mode label changed from `Code` to `Agent`.
  - Removed remaining Kilo wording from visible UI labels (sessions title/tips).
- Improved form navigation/editability:
  - Model/embeddings provider fields are now editable by typing (not arrow-only).
  - Added up/down focus movement across model/embeddings/advanced form fields.
- Fixed free-model routing mismatch in core/cli config path:
  - Added normalization so `openai-compatible` models with `:free` suffix route to gateway base URL (`https://api.kilo.ai/api/gateway`) instead of OpenRouter.
  - Applied this normalization for loaded config, `-m` CLI override, profile switch, and runtime saveConfig updates.
- Updated models catalog behavior (`packages/core/src/models/catalog.ts`):
  - Added support for `kilo` provider alongside OpenRouter.
  - Renamed display provider `kilo` -> `Nexus Gateway` in picker categories.
  - Added live filtering of `kilo` models through `GET /models` from gateway to hide stale/unavailable IDs from static `models.dev`.

## Why

Main user-facing regressions were caused by character extraction that dropped spaces/paste data, and by a provider/baseUrl mismatch where `*:free` model IDs were sent to OpenRouter endpoints that do not serve them.

## Validation

Executed:

```bash
pnpm --filter @nexuscode/core build
pnpm --filter @nexuscode/cli build
```

Smoke checks:

```bash
bun packages/cli/dist/index.js ask "Ответь одним словом: ok" --print -m "openai-compatible/minimax/minimax-m2.5:free"
# output: ok
```

Also verified interactive TUI startup with Bun and checked that typed input preserves spaces (including Cyrillic + spaces) in the prompt field.
