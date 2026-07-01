# FIXNOTES — fix/query-empty-and-frozen-results

Two production bugs on the tenant-plane `query` op (customer tool `find_in_record`), both live-verified against the Marcus tenant 2026-07-01. External acceptance gate: `loop-forge/loops/recall-canary/` asserts these invariants against the deployed plane — red before this fix, must be green after, stays on as a regression tripwire.

## F1 — empty results on first-person / compound queries

Customer symptom: "what do I know about Boltline" and "tell me about Sightline and its funding situation" → `[]`, while "Boltline" → strong hits. The agent then tells the customer their brain is empty.

Three stacked causes, each fixed in its own commit:

1. **Intent misclassification** (`c01f1fe4`, query-intent.ts): `ENTITY_PATTERNS` matched "what do **you/we** know" but not "what do **I** know" — first-person queries fell to GENERAL intent. Live discriminator that proved it from the public surface: the you-form returned 4 hits while the I-form returned `[]`. Fix: `(i|you|we)`.
2. **Detail-gated empty escalation** (`7e48c5e1`, hybrid.ts): the empty-result retry-at-high-detail fired only when `detail === 'low'` (the ENTITY-resolved value). GENERAL-intent queries resolve `detail: undefined`, so empties returned with no second look. Fix: escalate on empty regardless of intent class, at all three empty checkpoints, with an `_emptyEscalated` recursion guard and `detail !== 'high'` bound.
3. **Expansion results not unioned + silent expansion fallback** (`7e48c5e1` + `f6333513`): expanded sub-queries previously contributed only vector arms — keyword results for sub-queries were dropped, so compound queries lost their strongest anchors (fix: `keywordLists` union feeds RRF fusion, entity gating, and anchoring). Separately, when the expansion gateway errored, expansion silently fell back to the raw query (expansion.ts catch) — this is why the failing surface DRIFTED day to day: gateway health masked/unmasked the bugs above. Fix: one retry + loud warnings on fallback.

## F5 — one frozen result set served to different queries

Customer symptom (worse than F1 — silently *wrong*): with bare `{query}` args (the shape most MCP agent clients send), every query returned the identical result set — "Strider" and "Sightline funding" both answered with Boltline pages. Interleaved calls with `{detail:'low', limit:5}` were correct, same token, same session.

Root cause (`268b6586`, query-cache.ts): the `SemanticQueryCache` **lookup** matched by embedding similarity within a `(source_id, knobs_hash)` partition — no query-text term — `ORDER BY embedding <=> $1 LIMIT 1`. Distinct queries whose embeddings fell within the similarity threshold shared whatever row was cached first. Explicit `detail`/`limit` args dodged it only because they land in a different `knobs_hash` partition. The **store** side always wrote `query_text` (row id = hash of `source_id::query_text::knobs_hash`) — only the lookup ignored it.

Fix: `lookup()` takes `queryText` and the SQL requires `lower(trim(query_text)) = $5` alongside the similarity match; hybrid.ts passes the query at the lookup callsite.

**Deliberate semantics change:** with exact-text equality required, the cache no longer serves "semantically similar" queries — only repeat queries with identical normalized text. Hit rate drops; cross-query contamination becomes impossible. For a memory product, correctness wins. If semantic serving is ever wanted back, it needs a far tighter threshold plus result re-validation — behind a config flag.

**Residual question for review:** why the similarity threshold admitted "Strider" ↔ "Boltline"-class collisions at all — audit the tenant plane's `query_cache` similarity config (too-loose threshold vs. degenerate embeddings on some path). The exact-text gate kills the failure class either way, but the answer matters for anything else keyed on that embedding.

## Tests

- `test/query-intent.test.ts` — first-person forms classify ENTITY with canonical axes.
- `test/hybrid-empty-and-expansion.serial.test.ts` — empty-result escalation regardless of intent; recursion guard; expanded keyword union reaches fusion/anchoring.
- `test/query-cache.test.ts` — cache no longer serves a hit for a different query text within the similarity threshold; same-text hit still works.
- `test/search/expansion-fallback.test.ts` — gateway fallback warns loudly and retries once.

All 38 pass (4.4s targeted run). Full `bun run verify` gate: run with `GBRAIN_HOME` isolated (local thin-client config contaminates two checks otherwise).

## Deploy

Engine-side only; no schema migration (query_cache already stores query_text). Deploy to the customer plane is Sean-gated. Post-deploy acceptance: `loop-forge/loops/recall-canary/run.sh` must transition red → green (its evidence self-triages: bare-vs-detailargs twin = F5, compound cases = F1).
