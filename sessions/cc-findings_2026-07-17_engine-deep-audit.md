# Engine deep adversarial audit — findings

**Target:** gbrain ENGINE candidate `1b9d965` (tip of `integration-2026-07-17-engine-v-candidate`, confirmed via `git ls-remote` / fetch `c447f70..1b9d965`).
**Scope:** the Postgres-backed memory/data engine — the surface that had only targeted P0 audits (FS-2, VT-1..9, SR-1..9, N1, C2, fence, V-1, B4), never a comprehensive sweep. First box deploy since 07-11 + imminent real inbound users.
**Method:** ultracode 6-lens adversarial swarm (5 lenses + completeness critic) → independent adversarial verification of every finding → operator-driven local repro of the top items. 20 agents, 0 errors, ~1.6M tokens. READ-ONLY on any live box; all repro in a detached worktree at `1b9d965` under PGLite/bun. **Adjudication rule:** `pglite-engine.ts:831` `withSourceScope` is a documented pass-through — PGLite does **not** enforce RLS — so a local harness can confirm application-layer `WHERE source_id` bugs but **cannot** confirm/refute RLS-policy findings; those are marked PLAUSIBLE with a live-Postgres probe handed to Sean.
**Candidate note:** three fix tips are NOT yet folded into `1b9d965`: `fix/engine-fk-abort-residual` (`59a827a`, v116), `fix/engine-creation-version` (`eab2015`), `fix/engine-c1-a1` (`31049b4`). The first one matters — see FIX PACKET below.

---

## ⛔ BOTTOM LINE: ONE finding blocks the box deploy — and its fix is already written

**BLOCKER: `X1-integrity` — client-craftable FK-abort freezes fence→DB reconciliation.** CONFIRMED, reproduced RED on the exact candidate and GREEN under the fix. **The root fix already exists in the un-merged tip `fix/engine-fk-abort-residual` (`59a827a`, migration v116).** This is a **staging/merge gap, not an unfixed bug.**

> ### FIX PACKET (do this before box deploy)
> **Fold `fix/engine-fk-abort-residual` (`59a827a`, migration v116) into the engine candidate `1b9d965`.** v116 rebuilds `facts_superseded_by_fkey` as `ON DELETE SET NULL` (+ pre-cleans dangling pointers, + partial RI index), which removes the FK-abort trigger entirely. It ships its own red-first test (`test/facts-fk-abort-residual.test.ts`, 4/4).
> **Receipt (operator-run):**
> - On candidate `1b9d965` (no v116): borrowed the v116 red-first test onto the candidate worktree → **4/4 FAIL** (`facts_superseded_by_fkey.confdeltype='a'` = NO ACTION; `MIGRATIONS.find(v===116)` undefined). The bug reproduces on the exact code about to deploy.
> - At fix tip `59a827a` (v116 applied): same test → **4/4 PASS** (`confdeltype='n'` = SET NULL; migration `facts_superseded_by_fk_on_delete_set_null` applied, 111 migrations).
> **Residual (non-blocking, defense-in-depth):** the reconcile loop in `cycle/extract-facts.ts:254-330` still has no per-page try/catch around the wipe+reinsert (`deleteFactsForPage:289`, `insertFacts:328`), so *any* future error there aborts the whole phase and skips downstream pages. v116 removes the known FK trigger; a belt-and-suspenders per-page `try/catch … continue` (or a per-page savepoint) would contain any other wipe/reinsert fault. Nice-to-have, not a blocker.

**Everything else is NON-BLOCKING.** Nothing else is a live cross-tenant leak, data-loss, injection-to-storage, or auth-bypass on the intended two-DSN config. The tenant-plane isolation and fence integrity are fundamentally sound (see "Proven airtight"). The remaining 13 findings are: misconfiguration-gated cross-tenant defense-in-depth gaps, operator-plane injection hygiene, a structurally-inert paid-API spend cap, and search-honesty edges.

**Two strong recommendations to land with (not gating, but cheap + high-consequence):**
1. **`X1-cross` — add a fail-closed NOBYPASSRLS boot assertion.** The *entire* customer-plane isolation is contingent on `GBRAIN_DATABASE_URL` pointing at the NOBYPASSRLS `gbrain_tenant` role, and **nothing at boot or in doctor verifies it.** A single-plane superuser DSN (a common default) silently disables ALL isolation. One `SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user` check at startup converts silent total-isolation-loss into a loud fail-closed. Given real inbound users are imminent, land this.
2. **Keep `--enable-dcr` OFF on the customer plane.** DCR self-registration stores the *requested* scope verbatim (no cap — `oauth-provider.ts:278` inserts `${client.scope || ''}`) and pins `source_id='default'` (the operator brain). With DCR on, an anonymous caller can self-register `scope='admin'`/`'sources_admin'` and reach the provisioning/schema-pack/operator-brain surfaces (findings X3, L5-3, L6-1). It's off by default (`dcrDisabled: !enableDcr`); make "DCR off on the multi-tenant box" a documented hard requirement.

---

## Ranked findings (blast radius → verified severity)

Legend: **finder→verifier severity**. CONFIRMED = traced to ground / reproduced. PLAUSIBLE = mechanism real, exploitability not fully confirmable statically.

| # | ID | Finding | Blast | Sev | Verdict | Blocks |
|---|----|---------|-------|-----|---------|--------|
| 1 | **X1-int** | Client-craftable FK-abort freezes fence→DB reconcile (`cycle/extract-facts.ts:289`) | data-integrity | **high** | **CONFIRMED (repro'd)** | **YES** |
| 2 | X1-xt | No NOBYPASSRLS boot/doctor assertion → 1 DSN misconfig disables ALL isolation (`serve-http.ts:2205`) | cross-tenant* | med | CONFIRMED | no |
| 3 | L5-1 | Voyage spend cap structurally inert on two-DSN plane (fail-open, no accounting) (`operations.ts:4564`) | money | med | CONFIRMED | no |
| 4 | L6-1 | Schema-pack mutations write process-global file, no per-source ownership (`schema-pack/mutate.ts:139`) | integrity* | med | CONFIRMED | no |
| 5 | X2-int | Dedup-path supersede stamps unstable fence id → supersession chain link silently lost (`facts/save.ts:562`) | integrity | med | CONFIRMED | no |
| 6 | L5-2 | query/search discards app-layer source seal for remote `source_id`/`__all__`; RLS sole backstop (`operations.ts:1840`) | cross-tenant* | low | CONFIRMED | no |
| 7 | L4-1 | search op omits `cacheSourceId` → dead cache + savepoint churn; latent xt if cache RLS USING weak (`operations.ts:1676`) | cross-tenant* | low | CONFIRMED | no |
| 8 | X3-xt | DCR pins `source_id='default'` + stores scope verbatim → self-register reaches operator brain/admin (`oauth-provider.ts:276`) | cross-tenant* | low | CONFIRMED | no |
| 9 | I1 | extract_facts doesn't scrub restricted data from structured `entity` field (B4 gap) (`facts/extract.ts:236`) | injection* | low | CONFIRMED | no |
| 10 | I2 | `redactPgUrl` leaks password fragment when DSN password contains `@` (`url-redact.ts:15`) | injection* | low | CONFIRMED (repro'd) | no |
| 11 | X2-xt | `eval_candidates` WITH CHECK permissive (array-membership) → latent cross-tenant write-visibility (`sql/b7-policies.sql:201`) | integrity | low | CONFIRMED (latent) | no |
| 12 | L4-2 | keyword-only search RAW_FETCH_CAP truncation shown as non-degraded/no has_more (`operations.ts:1655`) | correctness | low | CONFIRMED | no |
| 13 | L4-3 | lexical-anchor per-term probe failure swallowed → narrowed/empty recall shown as honest no-match (`search/hybrid.ts:1448`) | correctness | low | CONFIRMED | no |
| 14 | L5-3 | `provisionSourceClient` lacks the `default`-source refusal `revoke` has (asymmetric guard) (`serve-http.ts:456`) | auth | low | PLAUSIBLE | no |

\* corrected by verifier to a lower/contained blast radius than the label suggests — see per-finding notes. None of the cross-tenant-labelled items is a live leak on the intended config.

---

## Per-finding detail

### 1. `X1-int` — Client-craftable FK-abort freezes fence→DB reconciliation ⛔ **BLOCKS DEPLOY** — CONFIRMED (reproduced)
- **File:** `src/core/cycle/extract-facts.ts:289` (root: `migrate.ts:2303` FK `NO ACTION`; `postgres-engine.ts:4186` `deleteFactsForPage`; `facts/save.ts:504-563`; `supersede.ts:148/157`).
- **Mechanism:** `facts.superseded_by` is a self-FK with default `NO ACTION`. The per-page reconcile wipe is a bare `DELETE FROM facts WHERE source_id=X AND source_markdown_slug=slug`. `findFactTextDuplicates` is **custody-blind** (filters only `source_id + expired_at IS NULL`, no slug filter), so a client `save_facts` whose text dedups to a fence-backed fact `F` while carrying `supersedes: R` (a prior **db-only** fact) stamps `R.superseded_by = F.id` via `expireFact` with no FK/source guard. `R` (NULL slug) survives the wipe; when `F`'s page reconciles, deleting `F` violates `facts_superseded_by_fkey` and throws. The reconcile loop has **no per-page try/catch** around the wipe/reinsert, so the exception aborts the whole `runExtractFacts` phase — every page after the poison is skipped, and `F`'s page can never reconcile while the poison row lives (recurs every cycle).
- **Harm:** durable, silent divergence of the derived DB index (which every recall/search hits) from the canonical fence — git-synced forgets/supersessions/new facts stop propagating for `F`'s page (and any co-batched slugs). On-disk fence is intact (no canonical fact loss); it is a within-tenant integrity/availability corruption of the served index, reachable from a supported op (incl. a prompt-injected agent driving `save_facts`). Verifier tempered "brain-wide" → "F's-page-permanent + collateral abort of co-batched slugs," but confirmed it blocks the box: durable, silent, untrusted-reachable, shipped with a containment comment the code doesn't implement.
- **Receipt:** RED on candidate (`confdeltype='a'`, v116 absent, 4/4 fail) / GREEN at `59a827a` (`confdeltype='n'`, v116 applied, 4/4 pass). See FIX PACKET.

### 2. `X1-xt` — No runtime NOBYPASSRLS assertion — CONFIRMED (misconfig-gated)
- **File:** `src/commands/serve-http.ts:2205`; unscoped reads at `postgres-engine.ts:5255` (`getStats` bare COUNT), `1735` (`listSources`), `operations.ts:1840-1843` (`search __all__`).
- **Mechanism:** all customer-plane isolation depends on the dispatch connection being the NOBYPASSRLS `gbrain_tenant` role (a BYPASSRLS role makes the `set_config` GUC inert and skips every policy). Multiple tenant-reachable reads carry NO app-level source predicate and rely SOLELY on RLS. Nothing at boot or in doctor checks `current_user`'s `rolbypassrls` (doctor only checks tables have `rowsecurity` ENABLED — a different property). A superuser/incumbent single-plane DSN → silent total isolation loss (all-tenant counts/source-ids/content).
- **Not a leak on the intended config**; probability gated on operator DSN misconfiguration, consequence catastrophic. **Fix:** fail-closed boot assertion + hard doctor FAIL (see recommendation #1). **Live probe for Sean (run against the box's op-dispatch DSN):** `SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;` — must be `f, f`.

### 3. `L5-1` — Voyage spend cap structurally inert on the customer plane — CONFIRMED
- **File:** `src/core/operations.ts:4564` (`checkBudget`) / `4606` (`recordSpend`); `spend-log.ts:52-57,111-114`; `sql/b7-role.sql` (mcp_spend_log = CAT-6, no tenant grant).
- **Mechanism:** on the customer plane `ctx.engine` is the `gbrain_tenant` pool; `mcp_spend_log` has no grant to that role, so `getTodaySpendCents`' SELECT and `recordSpend`'s INSERT both hit `permission denied`. `getTodaySpendCents` catches ALL errors → returns `0` → `checkBudget` sees `0 < cap` → never throws; `recordSpend` swallows the write. The cap meant to stop "a misbehaving OAuth client burning the operator's Voyage account" is fully bypassed exactly on the untrusted plane, and no spend is recorded (no accounting). Wallet-DoS if image search actually calls Voyage on that plane.
- **Fix:** run the spend gate on `privilegedEngine` (mirror the `mcp_request_log` audit-write pattern), or make `getTodaySpendCents` distinguish `permission denied`/undefined-table from empty-ledger and **fail CLOSED** on remote calls when the ledger is unreadable.

### 4. `L6-1` — Schema-pack mutations are a process-global shared resource with no owner binding — CONFIRMED
- **File:** `src/core/schema-pack/mutate.ts:139`; `operations.ts:4882` (ctx.sourceId only tags audit/cache-invalidation).
- **Mechanism:** `locateMutablePackFile(name)` = `gbrainPath('schema-packs', name)` — process/home-global, no `source_id` in the path or any write-side ownership check. An `admin`-scoped `schema_apply_mutations` on a **shared custom pack** (bundled packs are read-only) rewrites typing/alias/extractable/expert-routing/link-inference rules that *every* source resolving to that pack name inherits on next `loadActivePack` — corrupting other tenants' ingestion, never touching the DB/RLS plane the other lenses audited. Escalation is conditional on an untrusted party holding `admin` scope (via `--enable-dcr`, or a box granting admin to >1 tenant); default DCR-off posture = operator power, not untrusted escalation.
- **Fix:** namespace mutable packs by owner source, or add an ownership check in `withMutation`; gate the op behind a dedicated operator-only scope + `localOnly:true` unless remote pack authoring is opted into.

### 5. `X2-int` — Dedup-path supersede stamps an unstable fence id → chain link silently lost — CONFIRMED
- **File:** `src/core/facts/save.ts:562`; contract at `supersede.ts:21-24`.
- **Mechanism:** `supersede.ts`'s contract requires the `superseded by fact #<id>` fence marker to carry a **rebuild-stable db-only id**. The dedup caller passes `matchedId` from custody-blind `findFactTextDuplicates`, which can be a **fence-backed** row. When the target `G` is fence-backed, its fence row is struck with the unstable id; after `F`'s page reconciles (re-mint → new serial id), the marker id dangles; on `G`'s reconcile the guarded subselect degrades it to NULL. `G` stays expired (no resurrection, no wrong-fact mis-attribution — serials aren't recycled) but `superseded_by=NULL`: `recall(supersessions:true)` no longer shows the chain and the `superseded: N` receipt is retroactively unbacked. Metadata/lineage loss, not fact loss. Same class v0.42.24 was built to eliminate.
- **Fix:** in `supersedeFactDurably`, require the superseding id's `source_markdown_slug IS NULL` before the fence strike; else refuse the durable strike and disclose `durable:false`, or resolve to a stable db-only anchor.

### 6. `L5-2` — query/search discards the app-layer source seal for remote `source_id`/`__all__` — CONFIRMED (contained today)
- **File:** `src/core/operations.ts:1840-1845`.
- **Mechanism:** `querySourceScope` is EITHER the client-supplied `source_id` OR `sourceScopeOpts(ctx)`, never the intersection, and there is **no `ctx.remote` guard** (in deliberate contrast to `resolvePerCallMode` two lines away, which refuses remote overrides). A remote token passing `source_id='<victim>'` or `'__all__'` discards the documented P0 leak seal. **Contained today** by the `withSourceScope` RLS clamp (returns only the token's own rows / empty intersection) — but this op now rests on a SINGLE net instead of the intended two. Any regression running it outside `withSourceScope`, mis-setting the GUC, or on a BYPASSRLS role turns it into a live cross-tenant read.
- **Fix:** for `ctx.remote===true`, clamp — intersect client `source_id` with the token's allowedSources and refuse `'__all__'`; keep `sourceScopeOpts(ctx)` as an always-applied floor.

### 7. `L4-1` — search op omits `cacheSourceId` → dead cache + churn; latent xt — CONFIRMED (correctness; xt doubly-latent)
- **File:** `src/core/operations.ts:1676` (vs the fixed query op at `1913`).
- **Mechanism:** the `search` op spreads only `...scope`, never threads `cacheSourceId`/scalar `sourceId`; for a federated caller `sourceScopeOpts` returns `{sourceIds:[…]}` (scalar undefined), so `query_cache` store/lookup fall back to literal `'default'`. Under the tenant dispatch GUC, `store()`'s INSERT of `source_id='default'` is rejected by the query_cache RLS WITH CHECK → savepoint rollback (silent), and `lookup()` filtering `source_id='default'` AND-ed with the tenant USING = 0 rows. **Confirmed impact:** the search op's semantic cache is fully dead on the customer plane + one failed-INSERT/savepoint-rollback per request (DB churn); results stay correct. **Cross-tenant is doubly-latent** — the same WITH CHECK that kills the cache also prevents any `'default'`-keyed row from persisting, so nothing leaks unless the whole b7 policy is broken/absent.
- **Fix:** thread `cacheSourceId: ctx.sourceId` (match the query op); add a defense-in-depth test that query_cache RLS **USING** (not just WITH CHECK) is source-scoped.

### 8. `X3-xt` — DCR clients pin `source_id='default'` + store scope verbatim — CONFIRMED (flag-gated)
- **File:** `src/core/oauth-provider.ts:262-278`; `serve-http.ts:990,2195`.
- **Mechanism:** DCR hardcodes `source_id='default'` (operator brain) and `federated_read=['default']`, and inserts `${client.scope || ''}` — the **requested scope, uncapped** (`assertAllowedScopes` allows `admin`/`sources_admin`). With `--enable-dcr`, an anonymous caller can self-register `scope='admin'`/`'sources_admin'`, resolving to the operator's default brain and reaching the provisioning/schema-pack surfaces (ties to L6-1, L5-3). **Off by default** (`dcrDisabled: !enableDcr`).
- **Fix:** keep DCR off on multi-tenant boxes (document as hard requirement); if enabled, mint clients into a dedicated non-default sandbox source, cap DCR scope to `read`, and reject `--enable-dcr` when the two-DSN plane is active unless a sandbox source is configured.

### 9. `I1` — extract_facts doesn't scrub restricted data from the structured `entity` field — CONFIRMED (operator-plane)
- **File:** `src/core/facts/extract.ts:236,272`.
- **Mechanism:** `scanRestrictedData` runs only on `factText`; `candidate.entity` is stored verbatim as `entity_slug` with no scan (`scrubSurfaceForms`, the B4 fix, is never imported here). A card/SSN/credential routed into `entity` persists as `entity_slug`, can become an entity page slug, and is re-logged at `backstop.ts:468` (`slug=…`) on the fence-write-fail path — the exact re-logging `logRestrictedDrop` exists to prevent. **Operator/CLI plane only** — the chat gateway is broken-closed on the tenant plane, so only the operator's own turns reach this code; no cross-tenant path.
- **Fix:** run `scanRestrictedData` on `candidate.entity` (and free-text metric/unit/period) before `push()`, mirroring `scrubSurfaceForms`; share one detector across both planes.

### 10. `I2` — `redactPgUrl` leaks a password fragment on `@`-in-password — CONFIRMED (reproduced)
- **File:** `src/core/url-redact.ts:15`.
- **Mechanism:** `PG_URL_RE`'s userinfo group `([^@/?]*@)?` stops at the FIRST `@`; a password containing `@` leaks its tail into the host group, emitted in cleartext to first-party log sinks. **Receipt:** `redactPgUrl('postgresql://user:p@ss@host:5432/db')` → `postgresql://***@ss@host:5432/db` (leaks `ss`); `…p@ss@word@host…` → leaks `ss@word`. Operator's own DSN, no untrusted-input path; secret-hygiene/defense-in-depth only.
- **Fix:** use the WHATWG URL parser (blank username+password) or anchor userinfo on the LAST `@` before the host.

### 11. `X2-xt` — `eval_candidates` WITH CHECK permissive (array-membership) — CONFIRMED (latent, not reachable)
- **File:** `sql/b7-policies.sql:201`.
- **Mechanism:** policy is `USING/WITH CHECK (GUC = ANY(source_ids))` — write only requires the caller be a *member* of `source_ids`, not that `source_ids ⊆ {caller}`. A row with `source_ids=['caller','victim']` passes WITH CHECK and satisfies victim's USING → cross-tenant write-visibility at the policy layer. **Not reachable today:** the sole writer derives `source_ids` from RLS-confined search results (always `[caller]`), binds it as a parameter, and capture is config-gated. The one policy that doesn't fail closed against a foreign source value.
- **Fix:** tighten tenant-plane WITH CHECK to `source_ids <@ ARRAY[current_setting('app.current_source_id',true)]` (keeps federated READ, forbids cross-source write-visibility).

### 12. `L4-2` — keyword-only search truncation shown as non-degraded — CONFIRMED (opt-in mode)
- **File:** `src/core/operations.ts:1655`.
- **Mechanism:** the `mcp_keyword_only` branch breaks at `sqlOffset >= RAW_FETCH_CAP` (1000), indistinguishable on the wire from true SQL exhaustion; both return `search_health {degraded:false}` and there is no `has_more`. A page-until-short-page walker concludes "complete" while matches exist beyond raw offset 1000. Broader than claimed — page-grain best-chunk means it doesn't even need heavy dedup collapse. Opt-in operator mode, off by default; scope correctly threaded (no cross-tenant).
- **Fix:** when the loop exits on the safety bound (not on batch<PREFIX_BATCH), mark the response truncated (`degraded`/`has_more:true`).

### 13. `L4-3` — lexical-anchor probe failure swallowed → narrowed/empty recall shown as honest no-match — CONFIRMED (correctness)
- **File:** `src/core/search/hybrid.ts:1448` (sibling at `1166`).
- **Mechanism:** per-term anchor probes do `try { … } catch { return []; }`; a transient fault shrinks `anchored`, and `fused.filter(anchored.has)` drops results. `buildSearchHealth` computes `degraded` only from `meta.degraded`, which the probe-failure path never sets — in contrast to the vector arm (`vectorArmFailure → degraded:true`). So a probe-narrowed/empty set is emitted as an authoritative `degraded:false` no-match (F1/SR-class empty-vs-error). Bounded by the primary keyword arm (uncaught, throws honestly on systemic failure); trigger is an intermittent infra fault, not untrusted input.
- **Fix:** on any caught probe/expansion keyword failure, set `degraded:true` + `degraded_reason:'anchor_probe_failed'`, mirroring the vector-arm handling.

### 14. `L5-3` — `provisionSourceClient` lacks the `default`-source refusal `revoke` has — PLAUSIBLE (conditional)
- **File:** `src/commands/serve-http.ts:456` (vs `revoke` refusal at `624`).
- **Mechanism:** `revokeSourceClient` hard-refuses `source_id==='default'` (403); `provisionSourceClient` has no symmetric refusal — only the incidental mint-once 409 blocks it. In an **empty-default window** (fresh brain pre-onboarding, or an operator client purge), a `sources_admin` bearer could mint a read+write confidential client (with arbitrary `federated_read`) on the operator's `default` brain — escalating from tenant-provisioning to operator-brain read+write + cross-source read. PLAUSIBLE, not CONFIRMED: the window is not attacker-manufacturable (revoke refuses `default`), so it depends on an unmanufacturable precondition. `v60` backfill seeds no default client, so a fresh brain is a genuine bootstrap-window state.
- **Fix:** add the symmetric `if (source_id==='default') return 403 forbidden_default` to `provisionSourceClient`; don't rely on the incidental 409 for the reserved source.

---

## Per-lens verdicts + what was PROVEN AIRTIGHT

Negative results matter — the swarm confirmed the core of the engine is sound. Highlights:

**Lens 1 — Cross-tenant isolation (3 findings, 14 airtight): fundamentally SOUND on the intended two-DSN config.**
- `withSourceScope` uses transaction-local `set_config(...,true)` — verified NO bare `SET app.current_source_id` and NO `set_config(...,false)` anywhere in `src/`; GUC cannot survive onto a pooled connection; fail-closed on unset GUC → 0 rows (b8-rls-proof P-3).
- All 20 tenant-granted tables have a matching `b7_tenant_isolation` policy AND RLS enabled (six via the v35 backfill + `auto_rls_on_create_table` event trigger; facts also at `migrate.ts:2370`).
- The BYPASSRLS `privilegedEngine` is **never** threaded into op handlers — `dispatch.ts` carries only the scoped `engine`; no op can reach a BYPASSRLS connection.
- `pages` slug uniqueness is `UNIQUE(source_id, slug)` (no cross-tenant existence leak via unique-violation). `query_cache` PK embeds `source_id` (no cross-tenant cache collision). `/ingest` idempotency key is client-namespaced.
- Job-status ops are double-gated (scope `admin` + `minion_jobs` CAT-6 deny-by-grant). `localOnly` `file_*` ops are excluded from HTTP `mcpOperations`. `get_stats`/`sources_list`/`recall` run on the scoped tx (RLS-confined counts/totals). Ingest write-seal forces `authInfo.sourceId` and rejects a differing `x-gbrain-source-id`. CAT-2 EXISTS policies deny attaching child rows / edges into a foreign source.

**Lens 2 — Data integrity / fence (2 findings, 8 airtight): SOUND except the two supersede-path items above.**
- N1 tombstone dedup is source-scoped + depth-32-bounded; forget/decay tombstones stay re-assertable. Atomic fence writes (write-`.tmp` → re-parse → `introducesNewWarnings` gate → POSIX `rename`) — canonical markdown never partially written. `deleteFactsForPage` targets `source_markdown_slug` only (NULL-slug rows survive the wipe). `insertFacts` runs the whole page batch in one tx (unique-violation rolls back cleanly; `parseFactsFence` drops colliding row_nums with a warning). The `superseded_by` guarded subselect degrades dangling ids to NULL rather than aborting. B4 scrub covers both claim text and structured surface forms.

**Lens 3 — Injection / secrets (2 findings, 6 airtight):** no SQL-injection found on the audited paths (parameterized); restricted-data scrub solid on the save_facts claim path; the two gaps (I1, I2) are operator-plane hygiene, not attacker-reachable.

**Lens 4 — Search/recall correctness (3 findings, 7 airtight):** the SR-series honesty invariants hold on the audited return paths; the three findings are honesty edges (opt-in mode truncation, swallowed probe fault) not wrong-answer-on-the-main-path.

**Lens 5 — Auth / provisioning / money (3 findings, 8 airtight):** bearer→source resolution, scope hierarchy, ingest write-seal, and revoke are sound; the findings are a broken spend cap, a contained source-seal discard, and an asymmetric provision guard.

**Lens 6 — Completeness critic (1 finding, 5 airtight):** probed cycle/consolidation, job queue, embeddings/vector backfill, code-intel traversal, schema-pack, minion dispatch — the schema-pack mutation plane (L6-1) is the one real gap; the DB-plane consolidation/queue/vector paths respect source scope.

---

## Live probes for Sean (require box/privileged access — NOT run here)

1. **NOBYPASSRLS wiring (X1-xt) — run as the op-dispatch DSN:** `SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;` → must be `f, f`. If either is true, the customer plane has no isolation.
2. **query_cache RLS USING is source-scoped (L4-1 latent):** inspect the `query_cache` policy on the box — confirm the **USING** qual (not just WITH CHECK) is `source_id = current_setting('app.current_source_id', true)`.
3. **DCR posture (X3):** confirm `--enable-dcr` is OFF on the customer plane (`DCR: disabled` in the serve banner).

---

## Coverage / honesty notes
- PGLite cannot enforce RLS (pass-through), so RLS-dependent cross-tenant findings (X1-xt, L5-2, L4-1's leak leg) are adjudicated static + verifier-traced, marked as "contained by RLS on the intended config," with live probes above — not falsely upgraded to CONFIRMED-leak.
- The three un-merged fix tips were noted, not audited in depth; only `fix/engine-fk-abort-residual` bears on a finding (it fixes the blocker). `fix/engine-creation-version` (eab2015) and `fix/engine-c1-a1` (31049b4) touch versioning/search-infra and are orthogonal to these findings.
- 14 findings is a low count for a codebase this size — consistent with the prior targeted P0 waves having already hardened the highest-risk classes. The swarm's larger contribution is the airtight map above: the tenant-plane isolation and fence integrity are sound, and the residual risk is concentrated in (a) one un-merged fix, (b) operator misconfiguration surfaces (NOBYPASSRLS wiring, DCR), and (c) hygiene/honesty edges.
