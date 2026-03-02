# 2026-03-01 — NexusCode server (OpenCode-style), CLI and extension clients

## What changed

### New package: @nexuscode/server
- **Session HTTP API** (Hono, Node): `GET /session` (list), `POST /session` (create), `GET /session/:id`, `GET /session/:id/message`, `POST /session/:id/message` (stream NDJSON), `POST /session/:id/abort`.
- **Directory** via query `directory` or header `x-nexus-directory` (same idea as OpenCode’s directory).
- **POST /session/:id/message**: runs `runAgentLoop` (core) with `ServerHost` (auto-approve all), streams `AgentEvent` as NDJSON (one JSON object per line). Client can abort via `AbortController`/request close.
- **Entry**: `node packages/server/dist/cli.js` or `pnpm serve` (after build). Listens on `NEXUS_SERVER_PORT` (default 4097) and `NEXUS_SERVER_HOST` (default 127.0.0.1).

### CLI: server mode
- **`--server URL`** or **`NEXUS_SERVER_URL`**: when set, CLI does not run the agent in-process. It uses the server for sessions and streaming.
  - Session: create via `POST /session` or use existing (list / continue / `--session`).
  - Messages: load via `GET /session/:id/message`.
  - Send message: `POST /session/:id/message` with `{ content, mode }`, then consume NDJSON stream and push events into the existing TUI event stream.
- Same TUI (React/Ink), same events; only the source of events changes (server stream instead of local `runAgentLoop`).

### Extension: server mode (optional)
- **Setting `nexuscode.serverUrl`**: when set, the extension uses the NexusCode server for running the agent (same API as CLI). Provider branches in `runAgent`: if `serverUrl` then create session on server if needed, fetch POST and stream NDJSON, forward events; else current in-process `runAgentLoop`. Clear chat resets `serverSessionId` so the next message creates a new server session.

## Why
- User asked to copy OpenCode’s architecture: a server that manages sessions and runs the agent, with CLI and extension as clients. NexusCode now has its own server (sessions + runAgentLoop over HTTP), CLI and (optionally) extension connect to it when configured.

## Validation
- `pnpm run build` — all packages build.
- Server: `pnpm serve` then `curl http://127.0.0.1:4097/` returns `{"name":"NexusCode Server","version":"0.1.0"}`.
- CLI with server: start server, then `NEXUS_SERVER_URL=http://127.0.0.1:4097 node packages/cli/dist/index.js` (or `nexus --server http://127.0.0.1:4097`) — TUI loads, create/send message streams from server.

## References
- OpenCode: `sources/opencode` — server (Hono, session routes, SSE/streaming), worker, TUI as client.
- NexusCode server: `packages/server` (app, session routes, run-session, ServerHost).
- CLI client: `packages/cli/src/server-client.ts`, `index.ts` (serverUrl branch).
