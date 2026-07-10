# Engine acceptance corpus — the staged B1/B2/B3 contract, as runnable fixtures

Deterministic black-box acceptance cases for the three staged save_facts/recall
features on `b8-box-staging`, so they can be verified after deploy and never
silently regressed by a future engine change. Discipline mirrors the
virgil-worker corpus (`virgil-worker` branch `sprint/fixtures`,
`tests/acceptance/`): golden-exact comparison, byte-identical repeat runs,
NEVER-happens assertions on every execution, loud PENDING when a feature is
absent, honest exit codes.

Features under test (black-box through `dispatchToolCall` — the exact seam the
MCP stdio + HTTP transports share — never unit-test internals):

- **B1** `04882e1f` — recall fact rows carry the `provenance` key:
  `user_stated` / `model_inferred` / null-for-legacy all project; the customer
  plane still omits `source_session`.
- **B2** `2b8f9265` — `save_facts` supersedes: atomic insert+expire chain,
  duplicate+supersedes expires to the canonical row, self-supersession guarded,
  plain saves report `superseded: 0`, recall shows the chain and default recall
  drops the old value.
- **B3** `de3c505f` — per-claim `results[]`: index-aligned, dense, one entry
  per input claim, statuses honest across mixed batches, `fact_ids` keeps its
  skip shape, positional back-compat when nothing was dropped.
- **B4** `680c2dcf` interplay: where a case touches the restricted-data
  surface, assert only through the drop/strip categories the engine already
  names (`payment_card` | `ssn` | `credential`); a surface strip is NOT a
  dropped claim.

TEST ASSETS ONLY. Nothing here ships and nothing here changes application
code. Everything runs on an in-memory PGLite engine — no DATABASE_URL, no
provider keys, no network, no box.

## Run

```sh
bun install                       # once per fresh checkout
bun tests/acceptance/run.mjs      # verify (exit 0 = green)
bun tests/acceptance/run.mjs --only=2     # one class (B2)
bun tests/acceptance/run.mjs --only=2.1   # one case
```

BUN, not node — cases import the engine's TypeScript through its public seams.

Every runnable case must match its golden (`expected/<id>.json`) EXACTLY —
path-level first-diff on mismatch — and must repeat byte-identically: each case
executes TWICE, each execution on a FRESH engine, and any drift between the two
canonical captures fails the case. `never()` assertions run on every execution,
including `--record`, so a golden can never be minted over a violated contract.
A NO-NETWORK sentinel is armed around every case: any http(s) `fetch` on these
zero-LLM paths fails the case loudly.

## PENDING — how the corpus behaves on a tree without the features

On the box base (`b0b681ee`, box 0.42.23.0) the staged features are absent: the
affected cases report **PENDING** — counted and listed loudly at the end of
every run, never silently skipped, never a failure — and the runner exits 0.
The corpus is the TARGET contract: it lights up when the staged commits deploy.
To run it against a base tree, copy `tests/acceptance/` onto that checkout
(this branch carries the features, so in place here everything runs).

Feature probes: the staged features change EXISTING files, so each probe is
file + needle — a load-bearing line the feature commit added and the base
provably lacks. A pending case never imports engine code.

| requires        | probe file                | needle                                            | feature commit |
|-----------------|---------------------------|---------------------------------------------------|----------------|
| `b1_provenance` | `src/core/operations.ts`  | `provenance: r.provenance ?? null`                | 04882e1f       |
| `b2_supersedes` | `src/core/facts/save.ts`  | `supersedes: z.number().int().positive().optional()` | 2b8f9265   |
| `b3_results`    | `src/core/facts/save.ts`  | `SaveFactsClaimResult`                            | de3c505f       |

## Writing a case (the contract, exactly)

One file per class under `cases/`, named `class-NN-<slug>.mjs`, exporting:

```js
export const meta = { class: N, title: '…', requires: 'b?_…' };  // class default
export const cases = [{
  id: 'N.M',                 // '<class>.<case>' — also the golden filename
  title: '…',                // factual, product-voiced
  requires: 'b?_…',          // optional per-case override of meta.requires
  async run() { … return canonTimestamps({ … }); },
  never(cap, t) { t.no(cond, 'label'); t.must(cond, 'label'); },
}];
```

- `run()` builds its OWN engine via `makeEngine([sourceIds])` (fresh in-memory
  PGLite + `initSchema` + seeds the given tenant ids into `sources` — the
  `facts.source_id` FK), drives ONLY the public op layer via
  `dispatch(engine, name, args, customerCaller(sourceId))`, and closes the
  engine in `finally`. Fresh engine per execution is what makes fact ids
  (serials) deterministic — never share an engine across cases or executions.
- `customerCaller(sourceId)` is the customer-plane shape: source-bound,
  non-default OAuth client with `allowedSources: [sourceId]`. It flips BOTH
  `isCustomerScopedRemoteRead` (the `source_session` strip) and the recall
  owner-visibility carve-out (a tenant reads its own private `save_facts`
  rows). Use it unless a case is specifically about another plane.
- Seeding non-public state (e.g. B1's legacy unstamped row) may use engine
  seams (`engine.insertFact`, `engine.putPage`) — the READ or WRITE under test
  must stay black-box through `dispatch`.
- The returned capture must be JSON-safe and MUST pass through
  `canonTimestamps()` (see Determinism). Include the envelope verbatim
  (`{ isError, payload }`) — the golden locks the full customer-visible shape,
  additive keys included.
- `never(cap, t)` receives the CANONICAL capture. Encode every row of the
  feature's NEVER-happens column here (`t.no`), plus any expected-behavior
  guard a golden alone can't express (`t.must`). These run on record AND
  verify.
- Dedup is real (pg_trgm, threshold 0.85): claim texts within one tenant must
  be lexically distinct unless the case is ABOUT dedup; express corrections
  via explicit `supersedes` ids taken from earlier `fact_ids`, never via text
  overlap.
- Recall ordering is deterministic (`valid_from DESC, id DESC`) — later
  inserts list first; goldens can rely on it.

## Determinism rules

- `withDeterminism()` seeds `Math.random` / `crypto.getRandomValues` /
  `crypto.randomUUID` (worker-harness verbatim). The clock is NOT frozen — a
  deliberate, documented deviation from the worker corpus: engine row
  timestamps originate in SQL `now()` inside WASM Postgres, unreachable from a
  JS `Date` patch. Instead `canonTimestamps()` rewrites every ISO-8601 string
  VALUE in the capture to a positional token (`<t1>`, `<t2>`, … in stable walk
  order). Each occurrence gets its OWN token — value-dedup would flake when
  two wall-clock reads straddle a millisecond boundary in one run and not the
  other. `null` stays `null`, so "expired_at flipped from null to set"
  survives canonicalization and the goldens still lock the supersession chain.
  Timestamp ORDER relations are asserted in `never()` when they matter, not in
  the golden.
- Patches and the no-network sentinel are global — the runner executes cases
  strictly SEQUENTIALLY. Do not parallelize it; do not run two runners
  concurrently in one tree.

## Recording goldens

```sh
bun tests/acceptance/run.mjs --record            # all runnable cases
bun tests/acceptance/run.mjs --only=2 --record   # one class
```

Record ONLY on a tree where the feature exists and behaves as the feature
commit describes, and hand-review every golden against the feature's contract
before committing — the golden IS the contract. `--record` still enforces
byte-identical repeats and `never()`; it refuses nothing else, the reviewer is
you. Recorded goldens are re-record-stable: an immediate `--record` rerun
produces byte-identical files.

## Layout

```
tests/acceptance/
  README.md        this file
  _harness.mjs     probes, determinism, engine/dispatch builders, golden plumbing
  run.mjs          the runner (record + verify) — run with bun
  cases/           class-01 (B1), class-02 (B2), … one file per feature class
  expected/        goldens, one per case id
```

Class numbering: class 1 = B1, class 2 = B2, class 3 = B3 (reserved — probe
`b3_results` already exists in the harness). The corpus is intentionally NOT
registered in any default test target — box CI semantics stay untouched; run
it explicitly.
