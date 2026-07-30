#!/bin/sh
# NexusCode one-command installer for macOS and Linux.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REQUIRED_NODE_VERSION="$(tr -d '\r\nv' < "$ROOT/.nvmrc")"

find_node() {
  for candidate in \
    "${NEXUS_NODE:-}" \
    "${NVM_DIR:-${HOME}/.nvm}/versions/node/v${REQUIRED_NODE_VERSION}/bin/node" \
    "${HOME}/.nvm/versions/node/v${REQUIRED_NODE_VERSION}/bin/node" \
    "${HOME}/.volta/bin/node" \
    node \
    nodejs
  do
    [ -z "$candidate" ] && continue
    resolved="$(command -v "$candidate" 2>/dev/null || true)"
    [ -z "$resolved" ] && resolved="$candidate"
    [ ! -x "$resolved" ] && continue
    version="$("$resolved" -p 'process.versions.node' 2>/dev/null || true)"
    if [ "$version" = "$REQUIRED_NODE_VERSION" ]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "NexusCode requires Node.js ${REQUIRED_NODE_VERSION}." >&2
  echo "Install it once with nvm:" >&2
  echo "  source \"${HOME}/.nvm/nvm.sh\" && nvm install ${REQUIRED_NODE_VERSION}" >&2
  exit 1
fi

PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
exec "$NODE_BIN" "$ROOT/scripts/one-install.js" "$@"
