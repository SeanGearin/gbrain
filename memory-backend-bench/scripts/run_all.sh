#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ ! -d node_modules ]; then
  echo "[setup] installing Bun dependencies"
  bun install
fi

if [ ! -f data/longmemeval/longmemeval_s.json ] || [ ! -f data/locomo/locomo10.json ]; then
  bash scripts/fetch-datasets.sh
fi

HONCHO_PID=""
if [ "${START_HONCHO:-0}" = "1" ]; then
  mkdir -p results
  echo "[honcho] launching fixture in background"
  bash scripts/start-honcho-fixture.sh > results/honcho-fixture.log 2>&1 &
  HONCHO_PID="$!"
  trap 'if [ -n "$HONCHO_PID" ]; then kill "$HONCHO_PID" 2>/dev/null || true; fi' EXIT
  echo "[honcho] waiting for ${HONCHO_BASE_URL:-http://localhost:8000}/docs"
  HONCHO_READY=0
  for _ in $(seq 1 120); do
    if curl -fsS "${HONCHO_BASE_URL:-http://localhost:8000}/docs" >/dev/null 2>&1; then
      HONCHO_READY=1
      break
    fi
    sleep 2
  done
  if [ "$HONCHO_READY" != "1" ]; then
    echo "[honcho] fixture did not become ready; see results/honcho-fixture.log" >&2
    exit 1
  fi
fi

ARGS=(
  "--datasets" "${BENCH_DATASETS:-longmemeval-s,locomo}"
  "--backends" "${BENCH_BACKENDS:-gbrain,honcho}"
  "--seed" "${BENCH_SEED:-20260615}"
  "--context-token-budget" "${CONTEXT_TOKEN_BUDGET:-4096}"
  "--answer-max-tokens" "${ANSWER_MAX_TOKENS:-512}"
  "--top-k" "${TOP_K:-8}"
)

if [ -n "${BENCH_LIMIT:-}" ]; then
  ARGS+=("--limit" "$BENCH_LIMIT")
fi

bun src/cli.ts "${ARGS[@]}"
