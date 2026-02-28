# Nexus UI + Vector Integration Overhaul

**Date:** 2026-02-28  
**Type:** architecture

## What Changed

NexusCode now has unified, persistent configuration behavior in both VS Code and CLI for advanced agent settings:

- model/provider/baseUrl/apiKey + temperature,
- max mode settings,
- embeddings model settings,
- indexing + vector DB controls,
- tool/skill filtering thresholds.

VS Code webview was reworked into a multi-view layout (`Chat`, `Sessions`, `Settings`) with an expanded settings surface and session navigation.  
Core indexing initialization was moved behind a factory (`createCodebaseIndexer`) to ensure embeddings/vector dependencies are wired correctly and to safely fall back to FTS-only mode when vector prerequisites are missing.

## Why

Several advanced features were present in schema/docs but not fully wired in host runtimes (especially semantic index + embeddings). This created UX mismatch: options existed but did not always affect behavior. The change closes that gap and aligns UI controls with actual runtime behavior.

## What This Replaces

- Direct host-side `new CodebaseIndexer(...)` initialization with incomplete vector wiring.
- Shallow config updates in VS Code host (`Object.assign`) without durable file persistence.
- Single-view, limited VS Code webview settings experience.

## Watch Out For

- `vectorDb.autoStart` can only start local Qdrant endpoints; remote URLs are not auto-managed.
- If neither local qdrant binary nor Docker is available, semantic indexing degrades gracefully to FTS.
- VS Code setting overrides can still supersede saved `.nexus/nexus.yaml` values at runtime.

## Related

- `packages/core/src/indexer/factory.ts`
- `packages/core/src/indexer/qdrant-manager.ts`
- `packages/vscode/src/provider.ts`
- `packages/vscode/webview-ui/src/App.tsx`
- `packages/cli/src/index.ts`
