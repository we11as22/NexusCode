# 2026-03-01 — Server DB, pagination, memory-safe dialogs

## What changed

### Server: SQLite persistence
- **Database**: Sessions and messages are stored in SQLite (`~/.nexus/nexus-server.db` or `NEXUS_DB_PATH`). Replaces in-memory / file-based storage when using the server.
- **Schema**: `sessions` (id, cwd, ts, title), `messages` (session_id, ord, ts, role, content JSON, …). Enables listing sessions and switching between them from CLI and extension.
- **API**:
  - `GET /session` — list sessions from DB (by cwd).
  - `POST /session` — create session in DB.
  - `GET /session/:id` — session meta + `messageCount`.
  - `GET /session/:id/message?limit=50&offset=0` — **paginated** messages (default limit 50, max 200). Clients load only the window they need.
  - `POST /session/:id/message` — loads last 200 messages from DB into memory for the run, runs agent, then appends only **new** messages to DB. Long dialogs do not load full history into server memory.

### CLI: bounded memory when using server
- **Paginated load**: When `--server` / `NEXUS_SERVER_URL` is set, CLI loads only the **last 100 messages** for the current session (`getSession` + `getMessages` with `limit=100`, `offset=messageCount-100`). No full-history load.
- **In-memory cap**: After each new message (user/assistant), the in-memory message list is trimmed to the last 100 items so long runs do not grow unbounded.

### Extension: server sessions + bounded memory
- **Session list from server**: When `nexuscode.serverUrl` is set, `sendSessionList()` fetches from `GET /session` on the server (not local file storage). Session list and switch work against the server DB.
- **Switch session**: When user switches session with server mode, provider loads last 100 messages from server (`GET /session/:id/message?limit=100&offset=...`) and sets `this.session` + `serverSessionId`. No full history loaded.
- **After stream sync**: After streaming a reply, the extension syncs from server by fetching only the last 100 messages (paginated), not the full thread. Keeps extension memory bounded.

## Why
- **Persistence**: Sessions and dialogs must live in a DB so extension and CLI can switch between them and restore/continue work.
- **Memory safety**: Long dialogs must not load everything into memory; only what’s needed (e.g. last N messages) is loaded, with the rest in the DB and loaded on demand (e.g. future “load more” on scroll).

## Validation
- Server: create session, send message, restart server — session and messages still present (DB persisted).
- CLI with server: open session with many messages — only last 100 loaded; send several more — list stays capped.
- Extension with serverUrl: list sessions from server, switch session — messages load (last 100); send message, after stream only last 100 synced.

## References
- Server DB: `packages/server/src/db.ts` (SQLite, sessions, messages, pagination).
- Routes: `packages/server/src/routes/session.ts` (DB-backed list/create/get/messages with limit/offset).
- CLI: `packages/cli/src/server-client.ts` (`getMessages(..., { limit, offset })`, `getSession`), `index.ts` (last 100 load + slice cap).
- Extension: `packages/vscode/src/provider.ts` (`sendSessionList` from server, `switchSession` from server with last 100, sync after stream with last 100).
