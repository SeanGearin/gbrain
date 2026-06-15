# Results

No live-key run has been executed in this checkout. After filling `.env`, run:

```sh
START_HONCHO=1 bash scripts/run_all.sh
```

The run writes a filled table to `results/<run-id>/README.md`.

| Dataset | Backend | n | QA accuracy | Mean F1 | Median context tokens | Errors |
|---|---|---:|---:|---:|---:|---:|
| LongMemEval-S | gbrain | pending | pending | pending | pending | pending |
| LongMemEval-S | Honcho | pending | pending | pending | pending | pending |
| LoCoMo | gbrain | pending | pending | pending | pending | pending |
| LoCoMo | Honcho | pending | pending | pending | pending | pending |

Methodology labels to report with every number:

- Judge model: `JUDGE_MODEL`
- Answer model: `ANSWER_MODEL`
- Context token budget: `CONTEXT_TOKEN_BUDGET`
- Answer max tokens: `ANSWER_MAX_TOKENS`
- Top K: `TOP_K`
- Question order seed: `BENCH_SEED`
- Run date: emitted in each JSON row

Caveat: this is a measurement kit. The first completed run is still one judge, one run, and should be treated as "our run" until repeated.
