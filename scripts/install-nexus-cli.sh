#!/usr/bin/env sh
# One command: install deps, rebuild native modules, build, install nexus to ~/bin.
# Run from repo root: pnpm run cli   (or: sh scripts/install-nexus-cli.sh)
# After install, run "nexus" from anywhere — ensure PATH includes ~/bin first (which nexus → ~/bin/nexus).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN_DIR="${HOME}/bin"
echo "[install-nexus-cli] ROOT=$ROOT" >&2

# Remove old wrapper
rm -f "$BIN_DIR/nexus" 2>/dev/null || true

# Prefer real Node (not Bun). Skip sourcing nvm to avoid nvm.sh exiting with 3 in some environments.
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
  echo "Error: could not find Node (Bun is not supported). Install Node 18+ and ensure 'node' is Node (e.g. nvm use 20)." >&2
  echo "  If you use nvm: nvm install 20 && nvm use 20" >&2
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" -v)"
echo "Using Node: $NODE_BIN ($NODE_VERSION)"

echo "[1/4] Installing dependencies..."
set +e
pnpm install
_e=$?
set -e
if [ "$_e" -ne 0 ]; then echo "[install-nexus-cli] pnpm install failed (exit $_e)" >&2; exit "$_e"; fi

echo "[2/4] Rebuilding native modules (better-sqlite3) for this Node..."
pnpm rebuild better-sqlite3 2>/dev/null || true
(cd packages/core && pnpm rebuild better-sqlite3) 2>/dev/null || true

echo "[3/4] Building NexusCode..."
set +e
pnpm run build
_e=$?
set -e
if [ "$_e" -ne 0 ]; then echo "[install-nexus-cli] pnpm run build failed (exit $_e)" >&2; exit "$_e"; fi

CLI_DIST="$ROOT/packages/cli/dist"
if [ ! -f "$CLI_DIST/index.js" ]; then
  echo "Error: CLI build missing ($CLI_DIST/index.js)" >&2
  exit 1
fi
CLI_INDEX="$(cd "$CLI_DIST" && pwd)/index.js"

echo "[4/4] Installing nexus to ~/bin..."
# CLI TUI uses @opentui/core which requires Bun (bun:ffi). Use bun in the wrapper.
find_bun() {
  for candidate in bun "$(command -v bun 2>/dev/null)" /usr/local/bin/bun "$HOME/.bun/bin/bun"; do
    [ -z "$candidate" ] && continue
    B="$(command -v "$candidate" 2>/dev/null)" || B="$candidate"
    [ ! -x "$B" ] && continue
    B="$(cd "$(dirname "$B")" && pwd)/$(basename "$B")"
    if "$B" -e 'if(typeof Bun==="undefined")process.exit(1)' 2>/dev/null; then
      echo "$B"
      return
    fi
  done
  return 1
}
BUN_BIN=""
if find_bun >/dev/null 2>&1; then
  BUN_BIN="$(find_bun)"
fi
if [ -z "$BUN_BIN" ]; then
  echo "Bun not found. Installing unzip (required by Bun installer) and Bun..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq 2>/dev/null || true
    apt-get install -y unzip 2>/dev/null || { echo "Run as root or: sudo apt-get install -y unzip" >&2; exit 1; }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y unzip 2>/dev/null || { echo "Run as root or: sudo dnf install -y unzip" >&2; exit 1; }
  elif command -v yum >/dev/null 2>&1; then
    yum install -y unzip 2>/dev/null || { echo "Run as root or: sudo yum install -y unzip" >&2; exit 1; }
  else
    echo "Error: unzip is required to install Bun. Install unzip (e.g. apt-get install unzip) then run: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  fi
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  BUN_HOME="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_HOME/bin:$PATH"
  if [ -x "$BUN_HOME/bin/bun" ]; then
    BUN_BIN="$BUN_HOME/bin/bun"
  fi
  if [ -z "$BUN_BIN" ] && find_bun >/dev/null 2>&1; then
    BUN_BIN="$(find_bun)"
  fi
  if [ -z "$BUN_BIN" ]; then
    echo "Error: Bun install may have succeeded but bun not in PATH. Add to ~/.bashrc: export PATH=\"\$HOME/.bun/bin:\$PATH\" then run: source ~/.bashrc and re-run this script." >&2
    exit 1
  fi
  # Ensure .bashrc has Bun in PATH for future shells
  if [ -f "$HOME/.bashrc" ] && ! grep -q '\.bun/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo "" >> "$HOME/.bashrc"
    echo "# Bun" >> "$HOME/.bashrc"
    echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
    echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
  fi
fi
echo "Using Bun for CLI: $BUN_BIN ($("$BUN_BIN" -v 2>/dev/null || true))"
mkdir -p "$BIN_DIR"
WRAPPER="$BIN_DIR/nexus"
cat > "$WRAPPER" << EOF
#!/usr/bin/env sh
exec "$BUN_BIN" "$CLI_INDEX" "\$@"
EOF
chmod +x "$WRAPPER"
echo "Installed: $WRAPPER"

# Ensure ~/bin is first in PATH for this session and for future shells
ADD_PATH='export PATH="$HOME/bin:$PATH"'
if ! echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
  echo ""
  echo "Adding ~/bin to PATH in ~/.bashrc..."
  if [ -f "$HOME/.bashrc" ]; then
    if grep -q 'PATH=.*\$HOME/bin' "$HOME/.bashrc" 2>/dev/null; then
      echo "  (already present in ~/.bashrc)"
    else
      echo "" >> "$HOME/.bashrc"
      echo "# NexusCode CLI" >> "$HOME/.bashrc"
      echo "$ADD_PATH" >> "$HOME/.bashrc"
      echo "  Added to ~/.bashrc. Run: source ~/.bashrc"
    fi
  else
    echo "  Create ~/.bashrc and add: $ADD_PATH"
  fi
  echo ""
  echo "For this shell only, run: $ADD_PATH"
else
  echo ""
  echo "PATH already includes ~/bin. Run: nexus"
fi
echo "Done. From any directory run: nexus   (check: which nexus → $WRAPPER)"
