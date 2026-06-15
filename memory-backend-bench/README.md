# Memory Backend Bench

Standalone apples-to-apples benchmark kit for gbrain vs Honcho on the same public memory QA datasets.

For the implementation handoff and verification notes, read `HANDOFF.md`.

The kit owns dataset parsing, question order, reader prompt, judge prompt, budgets, JSON shape, and summary tables. Backends only implement the memory lifecycle:

`reset / upsert_peer / create_session / add_messages / await_index / consolidate / answer / context_answer / cleanup`

## Run

Fill `.env` from `.env.template`, then run:

```sh
START_HONCHO=1 bash scripts/run_all.sh
```

For a cheap smoke run:

```sh
BENCH_LIMIT=2 START_HONCHO=1 bash scripts/run_all.sh
```

Outputs land in `results/<run-id>/`:

- `results.jsonl`: identical per-question row shape for both backends
- `summary.json`: aggregate numbers plus rows
- `README.md`: table with gbrain vs Honcho by dataset

## What It Measures

Datasets:

- LongMemEval-S, fetched from Hugging Face.
- LoCoMo `locomo10.json`, fetched from `snap-research/locomo`.

Default budgets and labels:

- Answer mode: `shared-context-reader`
- Answer model: `ANSWER_MODEL` from `.env`
- Judge model: `JUDGE_MODEL` from `.env`
- Retrieval depth: `TOP_K`
- Context/read budget: `CONTEXT_TOKEN_BUDGET`
- Answer budget: `ANSWER_MAX_TOKENS`
- Question order: seeded shuffle via `BENCH_SEED`

Metrics:

- QA accuracy: one shared OpenAI judge, same prompt per dataset for both backends.
- F1: lexical token F1 against the gold answer.
- Median context tokens: tokens in the backend context passed to the shared reader.

## Honcho Fixture Boundary

Honcho is AGPL-3.0. This kit does not copy or vendor Honcho code. `START_HONCHO=1` clones `plastic-labs/honcho` into `/tmp/honcho-memory-bench` and starts its published local benchmark harness as an external service. You can also start Honcho yourself and set `HONCHO_BASE_URL`.

The kit depends only on the published `@honcho-ai/sdk` package to call that service.

## Useful Knobs

```sh
BENCH_DATASETS=longmemeval-s BENCH_BACKENDS=gbrain BENCH_LIMIT=10 bash scripts/run_all.sh
HONCHO_SKIP_DREAM=1 BENCH_LIMIT=5 START_HONCHO=1 bash scripts/run_all.sh
GBRAIN_REPO=/path/to/gbrain TOP_K=5 CONTEXT_TOKEN_BUDGET=2048 bash scripts/run_all.sh
```

## Caveats

- Single judge model, single run. Repeat across seeds before treating close calls as real.
- Shared-context-reader mode is intentionally fair, but it is not the same as each product's fully optimized direct answer endpoint.
- Honcho background reasoning depends on its local worker and queue completing inside `HONCHO_TIMEOUT_SECONDS`.
- The raw datasets and generated results are gitignored.
