# FIXNOTES — fix/query-empty-and-frozen-results

Two production bugs on the tenant-plane `query` op (customer tool `find_in_record`), both live-verified against the Marcus tenant 2026-07-01. External acceptance gate: `loop-forge/loops/recall-canary/` asserts these invariants against the deployed plane — red before this fix, must be green after, stays on as a regression tripwire.

## F1 — empty results on first-person / compound queries

Customer symptom: "what do I know about Boltline" and "tell me about Sightline and its funding situation" → `[]`, while "Boltline" → strong hits. The agent then tells the customer their brain is empty.

Three stacked causes, each fixed in its own commit:

1. **Intent misclassification** (`c01f1fe4`, query-intent.ts): `ENTITY_PATTERNS` matched "what do **you/we** know" but not "what do **I** know" — first-person queries fell to GENERAL intent. Live discriminator that proved it from the public surface: the you-form returned 4 hits while the I-form returned `[]`. Fix: `(i|you|we)`.
2. **Detail-gated empty escalation** (`7e48c5e1`, hybrid.ts): the empty-result retry-at-high-detail checked the CALLER's `opts.detail === 'low'`, so auto-detected 'low' (what ENTITY intent resolves — the F1 wrapper case) never escalated. Fix: gate on the RESOLVED `detail === 'low'` at all three empty checkpoints, with an `_emptyEscalated` recursion guard. (Escalation stays restricted to resolved-low on review: 'low' is the only level that narrows the searched chunk set, so retrying any other level is a guaranteed-futile second search — see Review hardening below.)
3. **Expansion results not unioned + silent expansion fallback** (`7e48c5e1` + `f6333513`): expanded sub-queries previously contributed only vector arms — keyword results for sub-queries were dropped, so compound queries lost their strongest anchors (fix: `keywordLists` union feeds RRF fusion, entity gating, and anchoring). Separately, when the expansion gateway errored, expansion silently fell back to the raw query (expansion.ts catch) — this is why the failing surface DRIFTED day to day: gateway health masked/unmasked the bugs above. Fix: one retry + loud warnings on fallback.

## F5 — one frozen result set served to different queries

Customer symptom (worse than F1 — silently *wrong*): with bare `{query}` args (the shape most MCP agent clients send), every query returned the identical result set — "Strider" and "Sightline funding" both answered with Boltline pages. Interleaved calls with `{detail:'low', limit:5}` were correct, same token, same session.

Root cause (`268b6586`, query-cache.ts): the `SemanticQueryCache` **lookup** matched by embedding similarity within a `(source_id, knobs_hash)` partition — no query-text term — `ORDER BY embedding <=> $1 LIMIT 1`. Distinct queries whose embeddings fell within the similarity threshold shared whatever row was cached first. Explicit args dodged it because `limit` participates in `knobs_hash` (`detail` does NOT — folding `detail_resolved` into knobsHash is a follow-up), so `limit: 5` probes landed in a different partition. The **store** side always wrote `query_text` (row id = hash of `source_id::query_text::knobs_hash`) — only the lookup ignored it.

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

## Review hardening (post-adversarial-review, 2026-07-01 late)

Two independent adversarial reviewers (hybrid-regression lens, cache-semantics lens) returned ship-with-notes; all real findings applied:

1. **Escalation gated on resolved `detail === 'low'`** — only 'low' narrows the searched chunk set; retrying undefined/medium-detail passes is a provably-futile second full search on every miss-query. Auto-detected 'low' (the F1 wrapper case) still escalates.
2. **Escalation checkpoints test the pre-slice pool** — pagination past the last page or a tight tokenBudget no longer triggers a spurious re-search ("search found nothing" ≠ "presentation trimmed everything").
3. **Escalated retry mints a fresh embed deadline** (`_queryEmbedDeadline: undefined`) — it no longer inherits a spent 6s AbortSignal window, which silently degraded the rescue to keyword-only exactly under slow-call conditions.
4. **Expansion timeout-class failures don't retry** — a stalled gateway (300s AI_CHAT_TIMEOUT) now falls back immediately; only fast errors get the single retry. Caps outage amplification.
5. **Cache fails closed without query text** — whitespace-only/absent text skips the cache instead of silently reverting to embedding-only matching (the F5 class).
6. **JS/SQL whitespace normalization aligned** — SQL side uses `btrim(query_text, E' \t\r\n')` to mirror JS `trim()` for the common classes.
7. **Reverted an unrequested CANONICAL_PATTERNS addition** — it would have changed recency/salience axes for previously-healthy you/we-form queries. The F1 fix needs only the ENTITY_PATTERNS amendment.

Deliberate non-fixes (watch, don't churn): expanded keyword arms tilt RRF slightly lexical and widen the tenant lexical-anchor set — intended union semantics; watch healthy-query rank stability via the recall-canary/evals. Cache-lookup functional index (`source_id, knobs_hash, lower(btrim(query_text,...))`) and folding `detail_resolved` into knobsHash are follow-ups, not blockers.

## Branch variants

- `fix/query-empty-and-frozen-results-b7line` (checkout `gbrain-search-fix`, off `6d0a5264`) — the SURGICAL deploy: only these fixes land on the line box2 currently runs.
- `fix/query-empty-and-frozen-results` (this branch, off fork/master v0.42.55.0) — the same fixes on the maintained master line, for whenever box2 upgrades.

Both variants carry the review hardening; full verify gate 30/30 green on both.
