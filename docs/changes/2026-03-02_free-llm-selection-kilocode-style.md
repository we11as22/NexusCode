# Free LLM selection (KiloCode-style integration)

## Summary

NexusCode now fully integrates **free model selection** in line with KiloCode (and OpenCode/Cline/Roo-Code patterns): the same models.dev catalog is used in both the VS Code extension and the CLI, with free models shown first and clear hints for OpenRouter free tier.

## Changes

### 1. Core: models catalog (`packages/core/src/models/catalog.ts`)

- Documented that free models (cost.input === 0) are sorted first so users can start without an API key (OpenRouter free tier).
- No logic change: catalog already sorts free first in `recommended` and in `getFallbackCatalog()`.

### 2. Extension webview: model picker (`packages/vscode/webview-ui/src/App.tsx`)

- **ModelPickerModal:** Recommended items that are free now show category **"Free (Recommended)"** instead of "Recommended".
- Added hint line under the modal title: *"Free models (OpenRouter) at top — no API key or get one at openrouter.ai"*.
- Settings LLM section: updated copy to *"Same catalog as KiloCode — free models first; OpenRouter base URL. No key required for free tier."*.

### 3. CLI: model picker (`packages/cli/src/tui/App.tsx`)

- **modelPickerOptions:** Free recommended models now use category **"Free (Recommended)"** so the TUI shows the same grouping as the extension.
- **ModelPickerView** subtitle: *"From models.dev — free models at top. Tab — manual provider/model."*.

### 4. Documentation

- **README.md:** New short paragraph under Configuration: *"Free model selection (KiloCode-style)"* — how to use "Select model" in extension and /model in CLI, and that the catalog is the same as KiloCode (models.dev), no API key required for free tier.
- **ARCHITECTURE.md:** New invariant bullet: catalog source (models.dev / env), free models sorted first, OpenRouter free tier.

## References

- KiloCode: models.dev, Kilo Gateway free models, `dialog-select-model-unpaid`, `dialog.model.unpaid.freeModels.title`, sidebar "Kilo includes free models so you can start immediately."
- Cline: `recommended-models.ts` (free array), onboarding group "free", OpenRouter default.
- Roo-Code: i18n "search free" for free options, OpenRouter provider.
- OpenCode: cost.input === 0 for free, model list and tags in UI.

## Behaviour

- **Default config** remains OpenRouter + `minimax/minimax-m2.5:free` (schema default in `config/schema.ts`).
- **Catalog:** Fetched from `NEXUS_MODELS_URL` or `NEXUS_MODELS_PATH` (or models.dev). Only OpenRouter provider is mapped; free detection is `cost.input === 0`.
- **Extension:** User opens Settings → LLM → "Select model (free models from models.dev)" → modal shows free models first with "(free)" label and "Free (Recommended)" category.
- **CLI:** User goes to /model, picker mode shows catalog with free models at top and "(free)" in the list; Tab switches to manual provider/model entry.
