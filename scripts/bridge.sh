#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Notes sync is best-effort: a notes bootstrap/clone failure (bad token, network,
# private repo unreachable) must never crash-loop the whole bridge. The agent
# runs fine without notes; it just loses the synced notes/ tree until fixed.
bash "$ROOT_DIR/scripts/ensure-notes.sh" || \
  echo "[notes] bootstrap failed; continuing without notes sync (see errors above)" >&2

# Run tsx directly (no npx layer) so SIGTERM from the supervisor reaches tsx,
# which forwards it to the Node process running the bridge — letting it drain
# the in-flight task gracefully instead of being killed.
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN" ]]; then
  exec "$TSX_BIN" src/index.ts "$@"
else
  exec npx tsx src/index.ts "$@"
fi
