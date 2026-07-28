#!/usr/bin/env sh
# Build a self-contained VSIX with the pinned runtime and install it into a
# local VS Code-family application when its CLI can be resolved.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REQUIRED_NODE_VERSION="$(tr -d '\r\n' < "$ROOT/.nvmrc")"
VSIX="$ROOT/packages/vscode/nexuscode-0.1.0.vsix"
EXTENSION_ID="nexuscode.nexuscode"
echo "[install-nexus-vscode] ROOT=$ROOT" >&2

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
    /opt/homebrew/bin/node
  do
    [ -z "$candidate" ] && continue
    NODE_CANDIDATE="$(command -v "$candidate" 2>/dev/null)" || NODE_CANDIDATE="$candidate"
    [ ! -x "$NODE_CANDIDATE" ] && continue
    NODE_CANDIDATE="$(cd "$(dirname "$NODE_CANDIDATE")" && pwd)/$(basename "$NODE_CANDIDATE")"
    if "$NODE_CANDIDATE" "$ROOT/scripts/check-node.js" >/dev/null 2>&1; then
      echo "$NODE_CANDIDATE"
      return
    fi
  done
  return 1
}

find_code() {
  for candidate in \
    "$(command -v code 2>/dev/null)" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "${HOME}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "${HOME}/Downloads/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "${HOME}/Desktop/Visual Studio Code.app/Contents/Resources/app/bin/code"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] && {
      echo "$candidate"
      return
    }
  done

  if command -v mdfind >/dev/null 2>&1; then
    for bundle_id in com.microsoft.VSCode com.microsoft.VSCodeInsiders
    do
      APP_PATH="$(mdfind "kMDItemCFBundleIdentifier == '${bundle_id}'" 2>/dev/null |
        sed -n '1p')"
      [ -z "$APP_PATH" ] && continue
      if [ "$bundle_id" = "com.microsoft.VSCodeInsiders" ]; then
        SPOTLIGHT_CODE="$APP_PATH/Contents/Resources/app/bin/code-insiders"
      else
        SPOTLIGHT_CODE="$APP_PATH/Contents/Resources/app/bin/code"
      fi
      [ -x "$SPOTLIGHT_CODE" ] && {
        echo "$SPOTLIGHT_CODE"
        return
      }
    done
  fi

  for candidate in \
    "$(command -v code-insiders 2>/dev/null)" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "$(command -v codium 2>/dev/null)" \
    "$(command -v cursor 2>/dev/null)" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] && {
      echo "$candidate"
      return
    }
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: could not find Node.js ${REQUIRED_NODE_VERSION}." >&2
  echo "Load nvm and run: nvm install ${REQUIRED_NODE_VERSION}" >&2
  exit 1
fi

echo "Using Node: $NODE_BIN ($("$NODE_BIN" -v))"
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH
if ! command -v corepack >/dev/null 2>&1; then
  echo "Error: corepack is not available next to the selected Node runtime." >&2
  exit 1
fi

echo "[1/3] Installing dependencies..."
corepack pnpm install
echo "[2/3] Building and packaging NexusCode VSIX..."
corepack pnpm package:vscode
[ -f "$VSIX" ] || {
  echo "Error: VSIX was not produced at $VSIX" >&2
  exit 1
}
if command -v unzip >/dev/null 2>&1; then
  unzip -t "$VSIX" >/dev/null
fi

if [ "${NEXUS_VSCODE_INSTALL:-1}" = "0" ]; then
  echo "[3/3] Installation skipped by NEXUS_VSCODE_INSTALL=0."
  echo "Built: $VSIX"
  exit 0
fi

CODE_BIN="$(find_code || true)"
if [ -z "$CODE_BIN" ]; then
  echo "[3/3] VS Code CLI was not found; the verified VSIX is ready:" >&2
  echo "$VSIX" >&2
  echo "Install it with Cmd/Ctrl+Shift+P -> Extensions: Install from VSIX..." >&2
  exit 1
fi

echo "[3/3] Installing with: $CODE_BIN"
"$CODE_BIN" --install-extension "$VSIX" --force
if ! "$CODE_BIN" --list-extensions --show-versions |
  grep -Eq "^${EXTENSION_ID}@0\\.1\\.0$"
then
  echo "Error: VS Code did not report ${EXTENSION_ID}@0.1.0 after installation." >&2
  exit 1
fi

echo "Installed and verified: ${EXTENSION_ID}@0.1.0"
echo "Reload VS Code, trust the workspace, then open NexusCode with Cmd/Ctrl+Shift+N."
