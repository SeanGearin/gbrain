#!/usr/bin/env bash
# scripts/run-integration-tests.sh
# Runs local integration fixtures that need resources outside pure unit tests
# (for example binding a local HTTP port). These are excluded from plain
# `bun test` and the default unit runner.

set -euo pipefail
cd "$(dirname "$0")/.."

files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.integration.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[run-integration-tests] no *.integration.test.ts files; nothing to do."
  exit 0
fi

echo "[run-integration-tests] running ${#files[@]} integration file(s)"
exec bun test --path-ignore-patterns "" --timeout=120000 "${files[@]}"
