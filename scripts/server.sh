#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Keep server-only startup aligned with bridge startup: the OpenCode server can
# load project skills/plugins that expect notes/ to exist, but notes bootstrap
# failure should not prevent serving.
bash "$ROOT_DIR/scripts/ensure-notes.sh" || \
  echo "[notes] bootstrap failed; continuing without notes sync (see errors above)" >&2

TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN" ]]; then
  exec "$TSX_BIN" src/server.ts "$@"
else
  exec npx tsx src/server.ts "$@"
fi
