#!/bin/sh
# Double-clickable macOS entry point. It intentionally delegates to the same
# verified installer used by `pnpm run ready`.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$ROOT/install.sh" "$@"
