# Exa browser tools (Kilo Code style)

**Date:** 2026-03-02

## Summary

Added Exa web and code search tools that work **without any API keys**, using Exa's public MCP endpoint (`https://mcp.exa.ai/mcp`), same as in Kilo Code / OpenCode.

## Changes

- **Core**
  - New tools: `exa_web_search` (real-time web search) and `exa_code_search` (library/SDK docs and code examples).
  - Both use JSON-RPC `tools/call` to Exa MCP; no `Authorization` or API key required.
  - Registered in search group and `READ_ONLY_TOOLS`; available in agent, plan, ask.
  - System prompt: added guidance to prefer Exa for up-to-date web/docs when appropriate.

- **CLI**
  - Icons: ◈ (Exa Web Search), ◇ (Exa Code Search).
  - Display names and tool preview show query text.

- **Extension**
  - ToolCallCard: icons, display names ("Exa Web Search" / "Exa Code Search"), input preview with query.
  - Running-state labels for Exa tools.

- **Docs**
  - DOCS.md: table updated with `web_search`, `exa_web_search`, `exa_code_search`.

## Notes

- Exa tools are read-only and can be parallelized with other read-only tools.
- For web search with your own key you can still use `web_search` (Brave/Serper).
- No config or env vars needed for Exa; they work out of the box.
