#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-"$ROOT/data"}"

mkdir -p "$DATA_DIR/longmemeval" "$DATA_DIR/locomo"

echo "[fetch] LongMemEval-S"
curl -L --fail \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s" \
  -o "$DATA_DIR/longmemeval/longmemeval_s.json"

echo "[fetch] LoCoMo locomo10.json"
curl -L --fail \
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" \
  -o "$DATA_DIR/locomo/locomo10.json"

echo "[fetch] wrote datasets under $DATA_DIR"
