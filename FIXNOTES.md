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

- `fix/query-empty-and-frozen-results-b7line` (this branch, off `6d0a5264`) — the SURGICAL deploy: only these fixes land on the line box2 currently runs.
- `fix/query-empty-and-frozen-results` (in `.codex-port/gbrain-f1f5`, off fork/master v0.42.55.0) — the same fixes on the maintained master line, for whenever box2 upgrades. Full verify gate 30/30 green there.

## F1 addendum — the binding cause on the tenant plane (found by the canary's post-deploy red, 2026-07-02)

After deploying the fixes above, F5 went green but every wrapper/compound case stayed hard-empty — and the honest cache exposed that yesterday's "second-person wrapper works" evidence had itself been an F5 cache mirage. Live probes then isolated the true binding cause: the tenant plane's `requireLexicalAnchor` gate anchors on whole-phrase keyword hits, and Postgres FTS ANDs terms — one out-of-corpus word ("what do you KNOW about Boltline", "Boltline INVOLVEMENT deal") empties the keyword arm, the anchor set goes empty, and the gate annihilates every vector hit. Probes: "about Boltline" → hits (stopword drops); "know about Boltline" → []; "purple elephant Boltline" → [].

Fix: when the whole-phrase keyword arms produce zero anchors and fused results exist, probe the query's significant terms individually (`anchorProbeTerms`, cap 6, filler-filtered) and anchor on their hits. A true off-world query still anchors to nothing and still gates to empty — the guard's purpose is preserved; conversational phrasing about real entities stops being annihilated. Tests: "conversational phrase … survives the gate via per-term anchors" + "true off-world query still gates to empty".

## fix/engine-recall-quality — 2026-07-16 (compound-parity acceptance landed + the time-travel version stamp)

Branch base: `b8-acceptance` (= `b8-box-staging` + the black-box acceptance corpus). Two recall-quality items:

### 1. Compound-query union — VERIFIED EXISTING, acceptance test landed on this line

The F1/F5 fix stack above (union expanded keyword results, empty-escalation at resolved-low, per-term anchor probe + union, honest cache) already sits in this line's history; the entity-chunk gap (entity pages with 0 content_chunks invisible to search_brain) was closed earlier by the construct/materialize pair (`06e9301` stub chunks at save, `7fa5bc7` facts→compiled_truth materialize). What was missing HERE was the acceptance invariant: `test/compound-query-parity.serial.test.ts` (cherry-picked from `b7-compound-query-union`, orig `04d2442`) pins, under the tenant-plane shape (`requireLexicalAnchor`):

- a compound question returns a SUPERSET of every sub-question run alone;
- a decomposer yielding nothing (or throwing) degrades to the raw query as a single search — never to empty.

Red-first receipt: at pre-fix base `6d0a526` the superset invariant fails (compound loses sub-question results to the anchor gate — the live [] class); on this branch 3/3 pass.

### 2. save_facts materialize now version-stamps (the time-travel poison)

`materializeEntityPages` rewrote entity pages via the low-level `putPage` upsert with no pre-update snapshot — a NON-versioning rewrite. Every save_facts batch that touched an entity moved `updated_at` with no `page_versions` row, so as-of reconstruction (worker `open_note_as_of`: "a snapshot at T holds the content that stood until T") could only refuse (`no_history`) for exactly the pages save_facts keeps current — permanent poison, worsening with every save.

Fix (`src/core/facts/construct.ts` Phase 3): snapshot the pre-update state via `createVersion` before each materialize rewrite — the same contract the put_page op (`import-file.ts` versions-on-existing) and `revert_version` (snapshot-before-revert) already honor. Phase 1's identical-body skip keeps the chain 1:1 with real content changes (duplicates/no-op batches mint nothing). Tenant-plane safe: plain INSERT..SELECT under grants `gbrain_tenant` already holds (`b7-role.sql` page_versions DML + sequence USAGE); the source-scoped feeding SELECT satisfies the b7 WITH CHECK.

Back-compat: pre-fix rewrites destroyed their pre-states — nothing can invent them. The first post-fix rewrite banks the page's CURRENT state, so the chain is whole from that rewrite forward; the older gap keeps the worker's honest `no_history` disclosure (updated_at moved, no covering snapshot) instead of today's text being served as the past.

Tests: `test/facts-materialize-versioning.test.ts` — red-first 0/4 pre-fix → 4/4 post-fix (stub banked on first materialize; prior body banked on the next — the as-of seam; no version spam on duplicate/no-op; poisoned legacy state banked on first post-fix touch).

Deploy: engine-side only, no schema migration (page_versions + grants already live). Box deploy is Sean-gated, as always.

## fix/engine-c1-a1 — 2026-07-17 (probe-cap position independence + supersede sanction honesty)

Branch base: `fix/engine-recall-quality @ 5190c7f`. Closes the two engine-side findings from the 2026-07-16 adversarial verify (C1 MED, A1 LOW-MED); E1 from that verify routes to the worker, not this line.

### 1. C1 — the first-6 anchor-probe cap was a live still-empty shape

The F1-addendum probe above capped at the FIRST 6 significant terms in query order, so a compound question front-loading >=6 significant out-of-corpus terms before the entity name ("give me your best comprehensive holistic strategic overall assessment regarding Sightline", decomposer absent — the raw-fallback leg) spent the cap on junk, never probed the entity, and the gate annihilated every fused hit while "Sightline" alone returned pages. The addendum's "conversational phrasing about real entities stops being annihilated" only became a class statement with this fix.

Fix (`src/core/search/hybrid.ts` `anchorProbeTerms`): cap raised 6 → 12 (realistic asks carry <=12 significant terms, so all get probed — the airtight path); past the cap, selection is position-independent — entity-cased terms (TitleCase past the first word, ALLCAPS acronyms, letter+digit codes, read off the raw query before tokenization lowercases) take slots first, and the remainder fills from both ends inward, end first. Query order can no longer starve a leading or trailing entity term; only deep-middle terms of pathological >12-term queries can be dropped. The off-world guard is untouched: junk terms have no corpus hits, so they add no anchors, and a query with NO in-corpus term still gates to empty.

Tests: `test/anchor-probe-frontload.serial.test.ts` — red-first 2 pass / 3 fail at `5190c7f` (probe receipts show exactly [give, best, comprehensive, holistic, strategic, overall], never sightline, results []) → 5/5 post-fix. Pins: the receipted C1 shape, its all-lowercase variant (no case signal — the raise carries it), an over-cap 13-junk-term run before a trailing lowercase entity (the both-ends fill carries it), and the off-world guard asserted NON-vacuously (vector arm forced to surface the dense cluster; gate still empties it).

Not taken: widening the empty-fused path with probe hits (the "and/or" in the dispatch). When every retrieval arm is empty the gate isn't what emptied the result — injecting probe hits there turns a filter into a fallback retrieval arm with its own precision story (weak in-corpus junk terms would surface pages for off-target asks). Separate design call, not smuggled into a hardening fix.

### 2. A1 — the B2 supersede sanction now states its plane-honest scope

`save.ts`'s dedup-path `expireFact` sanction read "no fence/markdown source to reconcile through" — true on the b8 tenant plane (tenant sources have no `local_path`, so no fence lifecycle exists), false as the class statement it reads as: on a fence-backed brain a B2 supersede CAN target a fence-derived fact (the fence carries active/forgotten/supersededBy state), and a DB-only expire diverges from it — the supersession evaporates at the next rebuild while B2 already receipted `superseded: 1`.

Route taken: honesty narrowing (comment-only, zero behavior change) at both supersede-relevant sanction sites — the dedup-path `expireFact` and the atomic insert+expire arm at `insertFact`, which shares the gap for fence-derived targets. Each now states: tenant-plane sanctioned; fence-backed supersedes of fence-derived rows do NOT survive rebuild; cure = mirror `forgetFactInFence`'s canFence gate (forget.ts, the house standard in this file family). The gate route was NOT taken here because it is not the cheap option it looks like: fence supersedes need a `superseded by #N` reference that stays stable across rebuild, and fence rewrites take page locks + filesystem writes inside save_facts' tenant tx (forget runs as a standalone op) — and on the b8 plane this branch feeds, `canFence` is always false, so the gate would be dead code on the deploy target. That gate is the sanctioned operator-plane follow-up.

Deploy: engine-side only, no schema migration. Box deploy is Sean-gated, as always.
