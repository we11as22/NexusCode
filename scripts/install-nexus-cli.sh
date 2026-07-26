#!/usr/bin/env sh
# Install the portable Node CLI wrapper into ~/bin (or $NEXUS_BIN_DIR).
# Run from repo root: corepack pnpm run cli
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN_DIR="${NEXUS_BIN_DIR:-${HOME}/bin}"
echo "[install-nexus-cli] ROOT=$ROOT" >&2

find_node() {
  for candidate in node nodejs "$(command -v node 2>/dev/null)" "$(command -v nodejs 2>/dev/null)" /usr/bin/node /usr/bin/nodejs; do
    [ -z "$candidate" ] && continue
    N="$(command -v "$candidate" 2>/dev/null)" || N="$candidate"
    [ ! -x "$N" ] && continue
    N="$(cd "$(dirname "$N")" && pwd)/$(basename "$N")"
    if "$N" -e 'if(typeof globalThis.Bun!=="undefined")process.exit(1)' 2>/dev/null; then
      echo "$N"
      return
    fi
  done
  return 1
}

NODE_BIN=""
if find_node >/dev/null 2>&1; then
  NODE_BIN="$(find_node)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "Error: could not find Node.js 20.19.2." >&2
  exit 1
fi

echo "Using Node: $NODE_BIN ($("$NODE_BIN" -v))"
"$NODE_BIN" "$ROOT/scripts/check-node.js"

echo "[1/3] Installing dependencies..."
corepack pnpm install

echo "[2/3] Building NexusCode core and CLI..."
corepack pnpm build:core
corepack pnpm build:cli

CLI_DIST="$ROOT/packages/cli/dist"
if [ ! -f "$CLI_DIST/index.js" ]; then
  echo "Error: CLI build missing ($CLI_DIST/index.js)" >&2
  exit 1
fi
CLI_INDEX="$(cd "$CLI_DIST" && pwd)/index.js"

echo "[3/3] Installing nexus to $BIN_DIR..."
mkdir -p "$BIN_DIR"
WRAPPER="$BIN_DIR/nexus"
WRAPPER_TMP="$WRAPPER.tmp.$$"
cat > "$WRAPPER_TMP" << EOF
#!/usr/bin/env sh
exec "$NODE_BIN" "$CLI_INDEX" "\$@"
EOF
chmod +x "$WRAPPER_TMP"
mv "$WRAPPER_TMP" "$WRAPPER"
echo "Installed: $WRAPPER"

if ! echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
  echo "Add $BIN_DIR to PATH to run nexus from any directory." >&2
else
  echo "PATH already includes $BIN_DIR. Run: nexus"
fi
echo "Done. Wrapper: $WRAPPER"
