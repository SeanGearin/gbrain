# CC findings — extract_facts "1280 and 1536" — Task 1 LOCATE checkpoint, 2026-06-07

Repo: gbrain fork. Branch: `b7-extract-embed-resolution` (off `b7-tenant-query-cache-rls` @ f81ba79). **No code edits.** Findings-only checkpoint per packet's Task-1 gate ("report the map + the divergence mechanism before editing anything").

## TL;DR — the packet's premise does not survive the code read

The packet inferred: *"the engine's `extract_facts` insert lane resolves a 1536-d embedding through a path the `save_facts` lane does not share."* **There is no such code path.** Both lanes compute their fact embedding through the identical chokepoint, so neither can produce a 1536 vector from code given the same in-process gateway config. The 1536 is **runtime/config state**, not a divergent resolver. Three surviving hypotheses are listed below; box probes discriminate them.

## What the code says (verified by read, not inference)

### Both lanes embed through one chokepoint
| Lane | Embed call site | Resolution |
|---|---|---|
| `extract_facts` | `src/core/facts/extract.ts:237` — `embedOne(factText)` | → `embed()` → `cfg.embedding_dimensions ?? DEFAULT` |
| `save_facts` | `src/core/facts/save.ts:196` — `embedOne(cleaned)` | → same `embed()` → same line |

- `embedOne` is literally `const [v] = await embed([text])` (`gateway.ts:1373`).
- `embed()` resolves `effectiveDims = opts?.dimensions ?? cfg.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS` (`gateway.ts:1158`).
- `DEFAULT_EMBEDDING_DIMENSIONS = 1280` (`src/core/ai/defaults.ts:21`). **An *unset* config yields 1280, not 1536.** Producing 1536 requires `cfg.embedding_dimensions === 1536` explicitly in the running process.
- The gateway is a module singleton (`requireConfig()`). Within one process both lanes resolve the same model + dims. `extract.ts` has no second embedding client; `extractFactsFromTurn` calls only `embedOne`.

### The embedding config is frozen at boot from the FILE plane
`reconfigureGatewayWithEngine(engine)` (`gateway.ts`) re-resolves expansion + chat from the DB plane but **intentionally does NOT re-resolve embedding** (verbatim comment: *"Embedding is intentionally NOT re-resolved here — switching embedding models invalidates [columns/caches]"*). So the running gateway's `embedding_model` / `embedding_dimensions` come **only** from `configureGateway(loadConfig())` at process start — i.e. the file-plane `config.json` under the service's `GBRAIN_HOME`. **The DB-plane config (1280) cannot override a process that booted with a 1536 file-plane config.**

### The error string pins the failure to a distance op, not the INSERT
`different vector dimensions 1280 and 1536` is pgvector's **binary-operator** error (`<=>`/`<->`), not its insert error (`expected N dimensions, not M`). On the extract lane the first `<=>` is the entity-scoped dedup search `save_facts` never calls:
- `backstop.ts:345` → `findCandidateDuplicates` → `postgres-engine.ts:3303`: `ORDER BY embedding <=> '<query-lit>'::vector` over `WHERE entity_slug=… AND embedding IS NOT NULL`.
- `save_facts` uses `findFactEmbeddingNeighbors` (`postgres-engine.ts:3374`) — same `<=>`, source-scoped, no entity prefilter. It would throw **identically** if its query dim ≠ stored dim.

So whichever side is 1536 (query vs stored), the comparison throws. Two facts to combine: (a) the operator capture throws; (b) per Sean, the ze-unification runbook DROP/ADD'd the facts column to 1280, re-embedded 2247/2247 rows, DB-verified 2026-06-07, and tonight tenant `save_facts` wrote + cosine-compared at 1280 into the **same** facts table (fact 2323). If stored rows are confirmed 1280, then the **query** embedding is the 1536 side → the operator *service* is embedding at 1536 → its in-process gateway holds a 1536 `embedding_dimensions` (stale file-plane config and/or unrestarted process).

## Engine-wide embedding-caller enumeration (Task 1.3)

Every site that COMPUTES an embedding routes through the gateway `embed`/`embedOne`/`embedQuery`/`embedBatch` family → `cfg.embedding_dimensions ?? DEFAULT (1280)`. There is **no second resolver** and no live use of the back-compat `EMBEDDING_DIMENSIONS = 1536` constant (`embedding.ts:127`) in any insert/search path.

| Call site | Lane | Resolution source | Dims at runtime |
|---|---|---|---|
| `facts/extract.ts:237` `embedOne` | extract_facts insert (fence) | gateway → cfg | configured (1280) |
| `facts/save.ts:196` `embedOne` | save_facts insert | gateway → cfg | configured (1280) |
| `search/hybrid.ts` `embedQuery` | recall/query | gateway → cfg (+col override) | configured |
| `import-file.ts` `embedBatch` | put_page/import chunks | gateway → cfg | configured |
| `commands/embed.ts` `embedBatch` | `embed --stale/--all` | gateway → cfg | configured — **content_chunks only, NEVER facts** |
| `cycle/extract-facts.ts` / dream phases | consolidate/extract | gateway → cfg | configured |
| `search/by-image.ts`, `reindex-multimodal.ts` | image lanes | column provider | 1024 (multimodal) |

Key structural facts:
- **No migration ever re-dimensions `facts.embedding`.** It is created once at v40 (`migrate.ts:2310`, `${vecType}(${embeddingDim})`) with `embeddingDim` read from the config table *at that time*. Every later `ALTER TABLE facts` adds non-embedding columns only. (A manual runbook re-created it at 1280 on the operator brain — outside the migration ledger.)
- `gbrain embed` does not touch the facts table — facts re-embedding only happens through the manual runbook.

## Three hypotheses (to discriminate on the box)

- **P1 — stale facts column/rows @ 1536 (originally proposed, now weakened).** Would require operator & tenant planes to hit *different* databases, since the runbook verified 1280 and tenant wrote 1280 tonight. Probe: facts column `format_type` + `vector_dims` histogram + same-DB confirmation.
- **P2 — plane/process config divergence (LEADING).** The operator serve process's in-memory gateway resolves `embedding_dimensions = 1536` (stale file-plane `config.json` under its `GBRAIN_HOME`, and/or a process that booted before the file went to 1280 — and embedding is never re-resolved from the DB). Fix: correct the file-plane config + restart the service. **~Zero code change.** Consistent with the packet's "restart the serving process(es)" operator note.
- **P3 — extract-lane-only code 1536 source.** By elimination if P1 and P2 are both negative. Resume Task 1 and locate it (gateway-configure / per-plane lead).

## Routing rule (agreed with Sean)
- P1 positive → STOP; facts-table migration is Sean's box-side call.
- P2 positive → fix is the operator service's config/runtime context; likely zero code.
- Both negative → resume Task 1, find the code-level 1536 source in the extract lane.

Read-only probe block (one command per message) handed to Sean separately. Do not proceed past the probes without their output.
