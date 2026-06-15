# Memory Backend Bench Handoff

Date: 2026-06-15

This directory is a standalone evaluation kit for an apples-to-apples memory benchmark:
gbrain versus Honcho on the same public datasets, with the same parser, question order,
judge, reader, budgets, and result schema.

## What Was Built

- Neutral TypeScript/Bun harness under `memory-backend-bench/src/`.
- Shared adapter contract:
  `reset / upsert_peer / create_session / add_messages / await_index / consolidate / answer / context_answer / cleanup`.
- gbrain adapter in `src/adapters/gbrain.ts`.
- Honcho adapter in `src/adapters/honcho.ts`.
- Dataset fetcher in `scripts/fetch-datasets.sh`.
- External Honcho fixture launcher in `scripts/start-honcho-fixture.sh`.
- One-command runner in `scripts/run_all.sh`.
- `.env.template` with required keys:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`.
- Placeholder results table in `RESULTS.md`; live runs emit filled tables under
  `results/<run-id>/README.md`.

## Design Choice

I used a thin neutral harness instead of the public `gbrain-evals` adapter interface.
The reason: local inspection showed `gbrain-evals` exposes a retrieval-oriented adapter
shape, while this benchmark needs a conversation-memory lifecycle shared by both systems.
The neutral harness keeps comparability centralized:

- Same LongMemEval-S and LoCoMo parsers.
- Same seeded randomized question order.
- Same context-token budget and answer-token budget.
- Same shared Anthropic context reader.
- Same OpenAI judge model and prompt per dataset.
- Same JSON result shape for both backends.
- Same median context-token accounting.

## Honcho Boundary

Honcho is AGPL-3.0. This repo does not copy or vendor Honcho code. The fixture launcher
clones `plastic-labs/honcho` into `/tmp/honcho-memory-bench` and starts its benchmark
harness as an external service. The local adapter calls that service through the
published `@honcho-ai/sdk` package.

## Run Commands

Create `.env` from `.env.template`, fill the keys, then run:

```sh
cd memory-backend-bench
START_HONCHO=1 bash scripts/run_all.sh
```

Cheap smoke run:

```sh
cd memory-backend-bench
BENCH_LIMIT=2 START_HONCHO=1 bash scripts/run_all.sh
```

Outputs:

- `results/<run-id>/results.jsonl`
- `results/<run-id>/summary.json`
- `results/<run-id>/README.md`

## Methodology Labels

Every result row emits:

- Backend and dataset.
- Question ID/type/text.
- Expected and actual answer.
- QA accuracy and pass/fail.
- Lexical F1.
- Context tokens for the answer context.
- Retrieved IDs.
- Budgets: top K, context-token budget, answer-token budget.
- Methodology: answer mode/model, judge model/prompt ID, answer prompt ID,
  run date, and question-order seed.
- Timings and adapter metadata.
- Error field.

Aggregate accuracy counts errored rows as misses while still reporting error count.

## Verification Done

From this kit before moving it into the repo:

- `bun run check` passed (`bunx tsc --noEmit`).
- Shell syntax checks passed for:
  - `scripts/run_all.sh`
  - `scripts/fetch-datasets.sh`
  - `scripts/start-honcho-fixture.sh`
- `bun src/cli.ts --help` worked.
- A no-key gbrain adapter reset/cleanup/teardown smoke check passed with
  `GBRAIN_KEYWORD_ONLY=1`.

The full benchmark was not run because it requires live API keys and dataset downloads.

## Caveats

- Single judge model, single run. Repeat across seeds before treating close differences
  as real.
- Shared-context-reader mode measures memory context quality plus one fixed reader; it is
  intentionally fair, but not each product's optimized direct-answer endpoint.
- Honcho background reasoning depends on its worker and queue completing within
  `HONCHO_TIMEOUT_SECONDS`.
- Datasets and generated results are intentionally gitignored.

