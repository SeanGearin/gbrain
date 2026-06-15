#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${HONCHO_FIXTURE_DIR:-/tmp/honcho-memory-bench}"
PORT="${HONCHO_PORT:-8000}"

if [ ! -d "$FIXTURE_DIR/.git" ]; then
  echo "[honcho] cloning AGPL fixture into $FIXTURE_DIR"
  git clone --depth 1 https://github.com/plastic-labs/honcho.git "$FIXTURE_DIR"
else
  echo "[honcho] using existing fixture at $FIXTURE_DIR"
fi

cd "$FIXTURE_DIR"
if command -v uv >/dev/null 2>&1; then
  uv sync
else
  echo "[honcho] uv is required by Honcho. Install uv, or start Honcho yourself and set HONCHO_BASE_URL." >&2
  exit 1
fi

echo "[honcho] starting harness on port $PORT"
python tests/bench/harness.py --port "$PORT" --project-root "$FIXTURE_DIR"
