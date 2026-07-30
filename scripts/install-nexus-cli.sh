#!/usr/bin/env sh
# Install the portable Node CLI wrapper into ~/bin (or $NEXUS_BIN_DIR).
# Run from repo root: corepack pnpm run cli
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN_DIR="${NEXUS_BIN_DIR:-${HOME}/bin}"
REQUIRED_NODE_VERSION="$(tr -d '\r\n' < "$ROOT/.nvmrc")"
echo "[install-nexus-cli] ROOT=$ROOT" >&2

find_node() {
  for candidate in \
    node \
    nodejs \
    "$(command -v node 2>/dev/null)" \
    "$(command -v nodejs 2>/dev/null)" \
    "${NVM_DIR:-${HOME}/.nvm}/versions/node/v${REQUIRED_NODE_VERSION}/bin/node" \
    "${HOME}/.nvm/versions/node/v${REQUIRED_NODE_VERSION}/bin/node" \
    "${HOME}/.volta/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /usr/bin/node \
    /usr/bin/nodejs
  do
    [ -z "$candidate" ] && continue
    N="$(command -v "$candidate" 2>/dev/null)" || N="$candidate"
    [ ! -x "$N" ] && continue
    N="$(cd "$(dirname "$N")" && pwd)/$(basename "$N")"
    if "$N" "$ROOT/scripts/check-node.js" >/dev/null 2>&1; then
      echo "$N"
      return
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: could not find Node.js ${REQUIRED_NODE_VERSION}." >&2
  echo "Install it with nvm: source \"${HOME}/.nvm/nvm.sh\" && nvm install ${REQUIRED_NODE_VERSION}" >&2
  echo "If nvm is not installed, install Node ${REQUIRED_NODE_VERSION} and ensure its node binary is available in PATH." >&2
  exit 1
fi

echo "Using Node: $NODE_BIN ($("$NODE_BIN" -v))"
"$NODE_BIN" "$ROOT/scripts/check-node.js"
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
if ! command -v corepack >/dev/null 2>&1; then
  echo "Error: corepack is not available next to the selected Node runtime." >&2
  exit 1
fi

echo "[1/5] Installing dependencies..."
corepack pnpm install

echo "[2/5] Building NexusCode core and CLI..."
corepack pnpm build:core
corepack pnpm build:cli

SOURCE_CLI_DIST="$ROOT/packages/cli/dist"
if [ ! -f "$SOURCE_CLI_DIST/index.js" ]; then
  echo "Error: CLI build missing ($SOURCE_CLI_DIST/index.js)" >&2
  exit 1
fi

SANDBOX_TARGET="$("$NODE_BIN" -p 'process.platform + "-" + process.arch')"
SANDBOX_NAME="nexus-sandbox"
if [ "$("$NODE_BIN" -p 'process.platform')" = "win32" ]; then
  SANDBOX_NAME="nexus-sandbox.exe"
fi
SANDBOX_BIN="$ROOT/packages/cli/vendor/$SANDBOX_TARGET/$SANDBOX_NAME"
if [ ! -x "$SANDBOX_BIN" ]; then
  echo "Error: native sandbox helper is missing or not executable ($SANDBOX_BIN)" >&2
  exit 1
fi
SANDBOX_VERSION="$("$SANDBOX_BIN" --version)"
case "$SANDBOX_VERSION" in
  "nexus-sandbox "*" protocol=1") ;;
  *)
    echo "Error: native sandbox helper failed its version probe: $SANDBOX_VERSION" >&2
    exit 1
    ;;
esac
SANDBOX_BACKEND="$("$SANDBOX_BIN" --check)"
case "$SANDBOX_BACKEND" in
  "nexus-sandbox backend="*" ready") ;;
  *)
    echo "Error: native sandbox backend failed its readiness probe: $SANDBOX_BACKEND" >&2
    exit 1
    ;;
esac

INSTALL_ROOT="${NEXUS_INSTALL_DIR:-${HOME}/.local/share/nexuscode}"
case "$INSTALL_ROOT" in
  ""|"/"|"$HOME")
    echo "Error: unsafe NexusCode install root: $INSTALL_ROOT" >&2
    exit 1
    ;;
esac
RUNTIME_VERSION="$("$NODE_BIN" -p "require('$ROOT/packages/cli/package.json').version")"
RUNTIME="$INSTALL_ROOT/runtime-$RUNTIME_VERSION"
STAGING="$RUNTIME.staging.$$"
BACKUP="$RUNTIME.backup.$$"
mkdir -p "$INSTALL_ROOT"
rm -rf "$STAGING" "$BACKUP"
echo "[3/5] Deploying an isolated CLI runtime..."
corepack pnpm --offline --filter @nexuscode/cli deploy --prod --legacy "$STAGING"
if [ ! -f "$STAGING/dist/index.js" ] || [ ! -x "$STAGING/vendor/$SANDBOX_TARGET/$SANDBOX_NAME" ]; then
  echo "Error: deployed CLI runtime is incomplete: $STAGING" >&2
  rm -rf "$STAGING"
  exit 1
fi
if [ -e "$RUNTIME" ]; then
  mv "$RUNTIME" "$BACKUP"
fi
if mv "$STAGING" "$RUNTIME"; then
  rm -rf "$BACKUP"
else
  [ ! -e "$RUNTIME" ] && [ -e "$BACKUP" ] && mv "$BACKUP" "$RUNTIME"
  exit 1
fi
CLI_INDEX="$RUNTIME/dist/index.js"

echo "[4/5] Installing nexus to $BIN_DIR..."
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

echo "[5/5] Verifying installed CLI and OS sandbox..."
"$WRAPPER" doctor --cwd "$ROOT"

if ! echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
  echo "Add $BIN_DIR to PATH to run nexus from any directory." >&2
else
  echo "PATH already includes $BIN_DIR. Run: nexus"
fi
echo "Done. Wrapper: $WRAPPER"
echo "Runtime: $RUNTIME"
