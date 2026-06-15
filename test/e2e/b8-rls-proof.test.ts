/**
 * B8 — cross-source denial proof for the B7 RLS backstop (design §F Layer 1).
 *
 * Standalone, engine-independent: raw `postgres` client + real `psql` apply of
 * the shipped sql/b7-policies.sql + sql/b7-role.sql. Runs against a LOCAL
 * scratch Postgres only. This is the executable form of the isolation gate:
 * with a real NOBYPASSRLS `gbrain_tenant` role and the shipped policies live,
 * cross-source reads and writes are denied BY POSTGRES, independent of any
 * app-layer filter.
 *
 * Gating: requires GBRAIN_B8_DATABASE_URL — a DELIBERATELY distinct env var.
 * A blanket `bun run test:e2e` (which sets DATABASE_URL) never picks this up,
 * and there is no fallback to DATABASE_URL, so the suite cannot accidentally
 * run against a shared or production DSN. The DSN must be a SUPERUSER (or
 * CREATEROLE + BYPASSRLS) connection to a throwaway database: the suite
 * creates and drops the `gbrain_tenant` role, which is CLUSTER-GLOBAL — never
 * point this at a cluster you share.
 *
 * Setup contract (the harness/runner does this before `bun test`):
 *   1. Scratch cluster + database exist; `vector` + `pg_trgm` extensions
 *      available (CREATE EXTENSION runs in initSchema).
 *   2. The DSN's role has BYPASSRLS (mirrors prod, where the incumbent gbrain
 *      role is BYPASSRLS=t — schema.sql's RLS-enable block is gated on it).
 *   3. `psql` reachable (override binary/flags via GBRAIN_B8_PSQL).
 *
 * Run:
 *   GBRAIN_B8_DATABASE_URL=postgres://gbrain@localhost:5499/gbrain_b8_scratch \
 *     bun test test/e2e/b8-rls-proof.test.ts
 *
 * Coverage map (packet 2026-06-11 / design §F):
 *   P-1  read denial across every policied table        (T-SQL-1)
 *   P-2  write denial: INSERT WITH CHECK + UPDATE/DELETE 0-row (T-SQL-2)
 *   P-3  fail-closed: unset AND empty GUC -> zero rows  (T-SQL-3)
 *   P-4  CAT-6 deny-by-GRANT: permission denied         (T-SQL-4)
 *   P-5  CAT-2 EXISTS + links both-endpoint WITH CHECK  (T-SQL-5 / D4)
 *   P-6  incumbent BYPASSRLS sees all sources           (T-SQL-6)
 *   P-7  defense-in-depth: mis-scoped query (app-layer bug simulated) still
 *        denied by the DB — the reason B7 exists        (T-HTTP-3 at SQL layer)
 *   P-8  GUC does not leak across transactions on a pooled connection
 *   P-9  STRUCTURAL: every table with a tenant DML grant carries the
 *        b7_tenant_isolation policy (D3 banked condition, executable)
 *   P-10 STRUCTURAL: every policy reads the GUC with missing_ok=true
 *        (the fail-closed form) — no policy can fail open on unset var
 *   P-11 oauth_clients/oauth_tokens/oauth_codes/access_tokens are deny-by-GRANT
 *        under the tenant role: SELECT raises `permission denied`, NOT 0 rows.
 *        The old vestigial SELECT grant (RLS-dead) was revoked on prod
 *        2026-06-11 and removed from b7-role.sql; shipped == live at the grant
 *        manifest (17 DML + SELECT-only sources/slug_aliases/page_aliases =
 *        20 policied tables as of 2026-06-14). Distinct from P-4 so these four
 *        can't silently regrow.
 *   P-12b same-source write availability across ALL 17 tenant-DML tables
 *        (pins the whole trigger/grant time-bomb class, not just pages)
 *   P-13a SOURCE PIN (runs everywhere, no DB needed): every CREATE OR REPLACE
 *        of bump_page_generation_clock_fn in src/ carries SECURITY DEFINER +
 *        pinned search_path — fails at test time, not prod-restart time, if an
 *        upstream merge reintroduces the unsafe form
 *   P-13b replay durability: initSchema replay over an already-fixed DB keeps
 *        prosecdef + search_path; tenant writes survive (the restart-clobber
 *        mechanism, simulated twice)
 *   P-13c READER SOURCE PIN (runs everywhere, no DB): every CREATE OR REPLACE of
 *        page_generation_clock_value in src/ carries SECURITY DEFINER + pinned
 *        search_path — the READ-path sibling of P-13a
 *   P-13d reader read-survival: a tenant cached store + lookup inside
 *        withSourceScope succeeds — the page_generation_clock_value() reads do
 *        NOT 42501 / poison the dispatch tx (the exact search_brain/query path
 *        that returned brain_unavailable; also the guard on PUBLIC EXECUTE of
 *        the reader fn)
 *   P-13e writer-fix + forced Layer-2: store() writes page_generations as a
 *        JSONB OBJECT (Fix B — raw-object bind, not the pre-fix double-encoded
 *        string scalar), and a cache MISS (clock bumped between store and lookup)
 *        drives jsonb_each(page_generations) on real postgres.js WITHOUT throwing
 *        — the Layer-2 path P-13d's Layer-1 hit never reached, and the encode
 *        PGLite hides. Asserts jsonb_typeof = 'object' after store + a served hit.
 *   P-13f shape-guard: a legacy double-encoded (string-scalar) page_generations
 *        row — the shape EVERY pre-fix prod row carries — invalidates CLEANLY on
 *        a forced Layer-2 eval (Fix A — jsonb_typeof guard short-circuits before
 *        jsonb_each) instead of raising 22023 and poisoning the dispatch tx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { execSync } from 'child_process';
import { join } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { SemanticQueryCache, cacheRowId } from '../../src/core/search/query-cache.ts';
import type { SearchResult, HybridSearchMeta } from '../../src/core/types.ts';

const DB = process.env.GBRAIN_B8_DATABASE_URL;
const describeB8 = DB ? describe : describe.skip;
if (!DB) {
  console.log('Skipping B8 RLS proof (GBRAIN_B8_DATABASE_URL not set — local scratch only)');
}

const A = 'b8proof_a';
const B = 'b8proof_b';
const TENANT_PW = 'b8_proof_tenant_pw_local_only';
const SQL_DIR = join(import.meta.dir, '..', '..', 'sql');
const DB_NAME = DB ? new URL(DB).pathname.replace(/^\//, '') : '';

/** The 20 tables sql/b7-policies.sql row-scopes, by category. */
const CAT1 = ['pages', 'ingest_log', 'files', 'facts', 'calibration_profiles',
  'take_proposals', 'take_nudge_log', 'think_ab_results', 'query_cache'];
const CAT2 = ['content_chunks', 'tags', 'timeline_entries', 'page_versions', 'raw_data', 'takes'];
/** SELECT-only, source_id-direct read-path alias tables. Same CAT-1 policy
 *  shape as the CAT1 set, but the tenant holds SELECT-ONLY (no DML grant), so
 *  they sit outside P-9's DML-granted coverage check while still being row-
 *  scoped + counted. Synced into the b7 manifest 2026-06-14 (policy 18 -> 20). */
const SELECT_ONLY_ALIASES = ['slug_aliases', 'page_aliases'];
const POLICED = [...CAT1, ...CAT2, 'links', 'eval_candidates', 'sources', ...SELECT_ONLY_ALIASES];

/** CAT-6 infra: no grant to gbrain_tenant -> permission denied on first touch.
 *  oauth_clients/oauth_tokens/oauth_codes/access_tokens are now ALSO deny-by-
 *  GRANT (vestigial SELECT revoked 2026-06-11) but stay pinned separately by
 *  P-11, not here. */
const CAT6_PROBE = ['minion_jobs', 'config', 'gbrain_cycle_locks', 'mcp_request_log',
  'dream_verdicts', 'subagent_messages'];

/** The only SELECT-only auth-bootstrap grant left to gbrain_tenant after the
 *  2026-06-11 revoke (b7-role.sql Step 2c). The oauth and access_tokens grants
 *  that used to sit here are gone — P-11 pins their deny-by-GRANT posture. */
const BOOTSTRAP_SELECT_ONLY = ['sources'];

function tenantUrl(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = 'gbrain_tenant';
  u.password = TENANT_PW;
  return u.toString();
}

/**
 * Apply a shipped .sql file the same way production does: hand it to real
 * psql, fed via STDIN (the `-f` form breaks when psql's OS user cannot
 * traverse the invoking user's home — the EC2 mode-750 lesson; stdin is opened
 * by the invoking shell, which owns the file). GBRAIN_B8_PSQL overrides the
 * psql invocation prefix (e.g. "docker exec -i pg17 psql -U postgres").
 */
function applyFile(file: string, opts?: { tenantPassword?: string }): void {
  const psqlBin = process.env.GBRAIN_B8_PSQL || `psql -d ${JSON.stringify(DB)}`;
  const varFlag = opts?.tenantPassword ? ` -v tenant_password=${opts.tenantPassword}` : '';
  const cmd = `${psqlBin} -v ON_ERROR_STOP=1${varFlag} < ${join(SQL_DIR, file)}`;
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`applyFile(${file}) failed: ${detail}`);
  }
}

describeB8('B8 cross-source denial proof (local scratch Postgres + gbrain_tenant)', () => {
  let admin: postgres.Sql;   // BYPASSRLS incumbent-equivalent (the scratch superuser)
  let tenant: postgres.Sql;  // gbrain_tenant — NOBYPASSRLS, the customer plane role
  let aPageId = 0;
  let bPageId = 0;

  beforeAll(async () => {
    // Bootstrap the full gbrain schema on the scratch DB (initSchema enables
    // RLS when the connecting role has BYPASSRLS — same path prod walked).
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: DB as string, poolSize: 2 });
    await engine.initSchema();
    await engine.disconnect();

    admin = postgres(DB as string, { prepare: false, max: 4 });

    // Sanity: the admin role must be BYPASSRLS-effective, or this scratch
    // doesn't mirror prod and every "incumbent unaffected" assertion is void.
    const [me] = await admin`
      SELECT rolbypassrls OR rolsuper AS effective
      FROM pg_roles WHERE rolname = current_user`;
    if (!me.effective) throw new Error('B8 scratch DSN role lacks BYPASSRLS/superuser — does not mirror prod');

    // Step 1 then Step 2, the shipped order (policies-complete-before-role-reachable).
    applyFile('b7-policies.sql');
    applyFile('b7-role.sql', { tenantPassword: TENANT_PW });
    // Belt-and-suspenders re-apply of the generation-clock ALTER script. The
    // DURABLE fix lives in the function definition in engine source (schema.sql
    // / schema-embedded.ts / migrate.ts v107 / pglite-schema.ts) — initSchema
    // above already created the function SECURITY DEFINER. Applying the script
    // here keeps the shipped triage artifact exercised (idempotent over an
    // already-fixed function) so it can't rot. See P-13a/b.
    applyFile('b7-fix-generation-clock.sql');

    // Seed two sources with at least one row in every seedable policied table.
    await admin`INSERT INTO sources (id, name) VALUES (${A}, 'B8 A'), (${B}, 'B8 B')
                ON CONFLICT (id) DO NOTHING`;
    const [pa] = await admin`INSERT INTO pages (source_id, slug, type, title)
      VALUES (${A}, 'people/a-one', 'person', 'A One') RETURNING id`;
    const [pb] = await admin`INSERT INTO pages (source_id, slug, type, title)
      VALUES (${B}, 'people/b-one', 'person', 'B One') RETURNING id`;
    aPageId = Number(pa.id);
    bPageId = Number(pb.id);

    await admin`INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
      VALUES (${aPageId}, 0, 'alpha chunk'), (${bPageId}, 0, 'bravo chunk')`;
    await admin`INSERT INTO tags (page_id, tag) VALUES (${aPageId}, 'a-tag'), (${bPageId}, 'b-tag')`;
    await admin`INSERT INTO timeline_entries (page_id, date, summary)
      VALUES (${aPageId}, '2026-01-01', 'a event'), (${bPageId}, '2026-01-01', 'b event')`;
    await admin`INSERT INTO raw_data (page_id, source, data)
      VALUES (${aPageId}, 'seed', ${admin.json({ k: 'a' })}), (${bPageId}, 'seed', ${admin.json({ k: 'b' })})`;
    await admin`INSERT INTO facts (source_id, fact, source)
      VALUES (${A}, 'a fact', 'seed'), (${B}, 'b fact', 'seed')`;
    await admin`INSERT INTO links (from_page_id, to_page_id) VALUES (${aPageId}, ${aPageId})`;
    await admin`INSERT INTO links (from_page_id, to_page_id) VALUES (${bPageId}, ${bPageId})`;
    // eval_candidates has no FK to sources — clear any prior-run residue first.
    await admin`DELETE FROM eval_candidates WHERE ${A} = ANY(source_ids) OR ${B} = ANY(source_ids)`;
    await admin`INSERT INTO eval_candidates
      (tool_name, query, retrieved_slugs, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
      VALUES ('search', 'qa', '{}', ARRAY[${A}], false, false, 1, true),
             ('search', 'qb', '{}', ARRAY[${B}], false, false, 1, true)`;

    tenant = postgres(tenantUrl(DB as string), { prepare: false, max: 4 });
  });

  afterAll(async () => {
    try { await tenant?.end({ timeout: 5 }); } catch { /* noop */ }
    if (admin) {
      try { await admin`DELETE FROM sources WHERE id IN (${A}, ${B})`; } catch { /* noop */ }
      try { await admin`DELETE FROM eval_candidates WHERE ${A} = ANY(source_ids) OR ${B} = ANY(source_ids)`; } catch { /* noop */ }
      try { applyFile('b7-rollback.sql'); } catch { /* noop */ }
      try { await admin.end({ timeout: 5 }); } catch { /* noop */ }
    }
  });

  /** Run `fn` on the tenant connection inside a txn with the source GUC set. */
  async function asTenant<T>(source: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    return tenant.begin(async (tx) => {
      await tx`SELECT set_config('app.current_source_id', ${source}, true)`;
      return fn(tx as unknown as postgres.Sql);
    }) as Promise<T>;
  }

  test('P-1 read denial: scoped to A, every policied table shows only A rows', async () => {
    await asTenant(A, async (tx) => {
      for (const tbl of POLICED) {
        const tenantRows = await tx.unsafe(`SELECT count(*)::int AS n FROM ${tbl}`);
        const adminRows = await admin.unsafe(
          tbl === 'sources'
            ? `SELECT count(*)::int AS n FROM sources WHERE id = '${A}'`
            : `SELECT count(*)::int AS n FROM ${tbl}`,
        );
        // Tenant must never see MORE than its own slice. For seeded tables the
        // bound is strict (admin sees 2 sources' rows, tenant exactly half or
        // its own); the universal invariant is: zero rows attributable to B.
        expect(Number(tenantRows[0].n)).toBeLessThanOrEqual(Number(adminRows[0].n));
      }
      // Strict assertions on the seeded core:
      const [pages] = await tx`SELECT count(*)::int AS n FROM pages`;
      expect(pages.n).toBe(1);
      const [byName] = await tx`SELECT count(*)::int AS n FROM pages WHERE source_id = ${B}`;
      expect(byName.n).toBe(0); // B invisible even when asked for by name
      const [chunks] = await tx`SELECT count(*)::int AS n FROM content_chunks`;
      expect(chunks.n).toBe(1);
      const [tags] = await tx`SELECT count(*)::int AS n FROM tags`;
      expect(tags.n).toBe(1);
      const [tl] = await tx`SELECT count(*)::int AS n FROM timeline_entries`;
      expect(tl.n).toBe(1);
      const [raw] = await tx`SELECT count(*)::int AS n FROM raw_data`;
      expect(raw.n).toBe(1);
      const [facts] = await tx`SELECT count(*)::int AS n FROM facts`;
      expect(facts.n).toBe(1);
      const [links] = await tx`SELECT count(*)::int AS n FROM links`;
      expect(links.n).toBe(1);
      const [evals] = await tx`SELECT count(*)::int AS n FROM eval_candidates`;
      expect(evals.n).toBe(1); // CAT-4 array membership
      const [srcs] = await tx`SELECT id FROM sources`;
      expect(srcs.id).toBe(A); // CAT-5 self-row only — cannot enumerate tenants
    });
  });

  test('P-2 write denial: INSERT into B rejected; UPDATE/DELETE of B affect 0 rows', async () => {
    await expect(
      asTenant(A, (tx) => tx`INSERT INTO pages (source_id, slug, type, title)
        VALUES (${B}, 'people/evil', 'person', 'Evil')`),
    ).rejects.toThrow(/row-level security/i);
    await asTenant(A, async (tx) => {
      const upd = await tx`UPDATE pages SET title = 'hacked' WHERE source_id = ${B}`;
      expect(upd.count).toBe(0);
      const del = await tx`DELETE FROM pages WHERE source_id = ${B}`;
      expect(del.count).toBe(0);
    });
    const [b] = await admin`SELECT title FROM pages WHERE id = ${bPageId}`;
    expect(b.title).toBe('B One'); // intact, verified above RLS
  });

  test('P-3 fail-closed: unset OR empty GUC yields ZERO rows, never all rows', async () => {
    const unset = await tenant.begin(async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(unset).toBe(0);
    const empty = await asTenant('', async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(empty).toBe(0);
  });

  test('P-4 CAT-6 deny-by-GRANT: infra tables are permission-denied outright', async () => {
    for (const tbl of ['minion_jobs', 'config', 'gbrain_cycle_locks', 'mcp_request_log', 'dream_verdicts', 'subagent_messages']) {
      await expect(
        asTenant(A, (tx) => tx.unsafe(`SELECT count(*) FROM ${tbl}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  test('P-5 CAT-2 EXISTS + links D4: foreign chunk invisible; cross-source edge write blocked', async () => {
    await asTenant(A, async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM content_chunks WHERE chunk_text = 'bravo chunk'`;
      expect(r.n).toBe(0);
    });
    // D4: WITH CHECK requires BOTH endpoints in-source. Distinct link_type so
    // the unique key can't fire — the only possible rejection is RLS (42501).
    let xEdgeErr: { code?: string; message?: string } | undefined;
    try {
      await asTenant(A, (tx) => tx`INSERT INTO links (from_page_id, to_page_id, link_type)
        VALUES (${aPageId}, ${bPageId}, 'b8_xsource_forbidden')`);
    } catch (e) {
      xEdgeErr = e as { code?: string; message?: string };
    }
    expect(xEdgeErr?.code).toBe('42501');
    expect(xEdgeErr?.message).toMatch(/row-level security/i);
    // Same-shape intra-source edge is allowed.
    await asTenant(A, async (tx) => {
      const ins = await tx`INSERT INTO links (from_page_id, to_page_id, link_type)
        VALUES (${aPageId}, ${aPageId}, 'b8_intra_ok')`;
      expect(ins.count).toBe(1);
    });
  });

  test('P-6 incumbent (BYPASSRLS) sees ALL sources with policies live', async () => {
    const [pages] = await admin`SELECT count(*)::int AS n FROM pages WHERE source_id IN (${A}, ${B})`;
    expect(pages.n).toBe(2);
  });

  test('P-7 defense-in-depth: mis-scoped query (simulated app-layer bug) still denied by the DB', async () => {
    // The app layer is GONE from this picture: scoped to A, the query asks for
    // B's rows by name with no app filter. Only the policy stands. It must hold.
    const leaked = await asTenant(A, async (tx) => {
      const rows = await tx`SELECT slug FROM pages WHERE source_id = ${B}`;
      return rows.length;
    });
    expect(leaked).toBe(0);
    // And the write-side twin: a "bug" that forgets the source filter on UPDATE
    // can still only reach its own rows.
    await asTenant(A, async (tx) => {
      const upd = await tx`UPDATE pages SET title = title`; // unfiltered UPDATE
      expect(upd.count).toBe(1); // only A's single page, never B's
    });
  });

  test('P-8 GUC does not leak across transactions on the same pooled connection', async () => {
    const a = await asTenant(A, async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    const b = await asTenant(B, async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(a).toBe(1);
    expect(b).toBe(1); // B sees its own, not A's — no bleed
    // Bare read after both scopes: transaction-local var evaporated -> 0 rows.
    const bare = await tenant.begin(async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(bare).toBe(0);
  });

  test('P-9 STRUCTURAL: every tenant DML grant carries the isolation policy (D3 banked condition)', async () => {
    // Any table gbrain_tenant can write must be row-scoped. A future grant
    // without a same-change policy is exactly the regression D3 banked.
    const granted = await admin`
      SELECT DISTINCT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'gbrain_tenant'
        AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')`;
    const policied = await admin`
      SELECT DISTINCT tablename FROM pg_policies WHERE policyname = 'b7_tenant_isolation'`;
    const policiedSet = new Set(policied.map((r) => r.tablename as string));
    const naked = granted
      .map((r) => r.table_name as string)
      .filter((t) => !policiedSet.has(t));
    expect(naked).toEqual([]); // every DML-granted table is policied
  });

  test('P-10 STRUCTURAL: every policy reads the GUC in the fail-closed (missing_ok) form', async () => {
    const rows = await admin`
      SELECT tablename, qual, with_check FROM pg_policies
      WHERE policyname = 'b7_tenant_isolation' ORDER BY tablename`;
    expect(rows.length).toBe(20);
    for (const r of rows) {
      const text = `${r.qual ?? ''} ${r.with_check ?? ''}`;
      // pg_policies renders it as current_setting('app.current_source_id'::text, true)
      expect(text).toContain("current_setting('app.current_source_id'::text, true)");
      expect(text).not.toContain("current_setting('app.current_source_id'::text)"); // no fail-open form
    }
  });

  test('P-12 availability: tenant can write its OWN source (no trigger/grant time bombs)', async () => {
    // The regression that catches the v107 generation-clock class: any future
    // trigger on pages (or its cascade) that touches a table the tenant role
    // lacks a grant on turns every tenant write into a 42501. Isolation must
    // not come at the price of the tenant being unable to write its own brain.
    await asTenant(A, async (tx) => {
      const ins = await tx`INSERT INTO pages (source_id, slug, type, title)
        VALUES (${A}, 'people/a-two', 'person', 'A Two')`;
      expect(ins.count).toBe(1);
      const upd = await tx`UPDATE pages SET title = 'A Two Renamed' WHERE slug = 'people/a-two'`;
      expect(upd.count).toBe(1);
      const del = await tx`DELETE FROM pages WHERE slug = 'people/a-two'`;
      expect(del.count).toBe(1);
    });
  });

  test('P-11 oauth/access_tokens are deny-by-GRANT under the tenant (permission denied, not 0 rows)', async () => {
    // The four auth tables used to carry a vestigial SELECT grant (the CAT-3
    // bearer-bootstrap carve-out): RLS-dead, so a tenant SELECT returned 0 rows
    // rather than erroring. That grant was REVOKEd from gbrain_tenant on prod
    // 2026-06-11 (runbook R-2) and removed from sql/b7-role.sql Step 2c, so a
    // scratch cluster built from shipped SQL now has NO grant here and live prod
    // matches. The tenant gets `permission denied` outright (deny-by-GRANT,
    // CAT-6 style) — the same posture P-4 pins for the infra tables. Kept as a
    // DISTINCT probe (these four specifically) so the grant manifest can't
    // silently regrow back to the 22-table shape without this test going red.
    for (const tbl of ['oauth_clients', 'oauth_tokens', 'oauth_codes', 'access_tokens']) {
      await expect(
        asTenant(A, (tx) => tx.unsafe(`SELECT count(*) FROM ${tbl}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  test('P-12b availability: same-source INSERT succeeds on ALL 17 tenant-DML tables', async () => {
    // P-12 proves pages; this pins the rest of the grant surface. One INSERT
    // per table (no 42501, no policy denial), UPDATE/DELETE smoke where cheap,
    // everything cleaned up inside the same transaction so the suite stays
    // re-runnable. A future trigger/grant time bomb on ANY of these tables
    // fails here instead of at first-light.
    await asTenant(A, async (tx) => {
      const step = async <T>(label: string, q: PromiseLike<T>): Promise<T> => {
        try {
          return await q;
        } catch (e) {
          throw new Error(`P-12b ${label}: ${(e as Error).message}`);
        }
      };

      // -- CAT-1: direct source_id column ----------------------------------
      const facts = await step('facts INSERT', tx`INSERT INTO facts (source_id, fact, source)
        VALUES (${A}, 'p12b fact', 'b8')`);
      expect(facts.count).toBe(1);
      const factsUpd = await step('facts UPDATE', tx`UPDATE facts SET fact = 'p12b fact v2'
        WHERE source_id = ${A} AND fact = 'p12b fact'`);
      expect(factsUpd.count).toBe(1);

      await step('files pre-clean', tx`DELETE FROM files WHERE storage_path = 'b8/p12b.txt'`);
      const files = await step('files INSERT', tx`INSERT INTO files (source_id, filename, storage_path, content_hash)
        VALUES (${A}, 'p12b.txt', 'b8/p12b.txt', 'p12b-hash')`);
      expect(files.count).toBe(1);

      const ingest = await step('ingest_log INSERT', tx`INSERT INTO ingest_log (source_id, source_type, source_ref)
        VALUES (${A}, 'b8', 'p12b')`);
      expect(ingest.count).toBe(1);

      await step('query_cache pre-clean', tx`DELETE FROM query_cache WHERE id = 'b8-p12b'`);
      const qc = await step('query_cache INSERT', tx`INSERT INTO query_cache (id, query_text, source_id)
        VALUES ('b8-p12b', 'p12b query', ${A})`);
      expect(qc.count).toBe(1);

      const calib = await step('calibration_profiles INSERT', tx`INSERT INTO calibration_profiles
        (source_id, holder, total_resolved, domain_scorecards, pattern_statements,
         voice_gate_passed, voice_gate_attempts, active_bias_tags, model_id)
        VALUES (${A}, 'b8', 0, '{}', '{}', true, 0, '{}', 'p12b-test')`);
      expect(calib.count).toBe(1);

      const prop = await step('take_proposals INSERT', tx`INSERT INTO take_proposals
        (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
         claim_text, kind, holder, weight, model_id)
        VALUES (${A}, 'people/a-one', 'p12b-hash', 'v1', 'p12b-run',
                'p12b claim', 'prediction', 'b8', 0.5, 'p12b-test')
        RETURNING id`);
      expect(prop.length).toBe(1);

      const nudge = await step('take_nudge_log INSERT', tx`INSERT INTO take_nudge_log
        (source_id, proposal_id, nudge_pattern)
        VALUES (${A}, ${prop[0].id}, 'b8_p12b')`);
      expect(nudge.count).toBe(1);

      const ab = await step('think_ab_results INSERT', tx`INSERT INTO think_ab_results
        (source_id, question, baseline_answer, with_calibration_answer, preferred)
        VALUES (${A}, 'p12b?', 'base', 'calib', 'tie')`);
      expect(ab.count).toBe(1);

      // -- CAT-4: source_ids array membership ------------------------------
      const evalC = await step('eval_candidates INSERT', tx`INSERT INTO eval_candidates
        (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
        VALUES ('search', 'p12b-q', ARRAY[${A}], false, false, 1, true)`);
      expect(evalC.count).toBe(1);

      // -- CAT-2: derived through pages (seed page aPageId is in source A) --
      const chunk = await step('content_chunks INSERT', tx`INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
        VALUES (${aPageId}, 99, 'p12b chunk')`);
      expect(chunk.count).toBe(1);

      const tag = await step('tags INSERT', tx`INSERT INTO tags (page_id, tag)
        VALUES (${aPageId}, 'p12b-tag')`);
      expect(tag.count).toBe(1);

      const tl = await step('timeline_entries INSERT', tx`INSERT INTO timeline_entries (page_id, date, summary)
        VALUES (${aPageId}, '2026-06-11', 'p12b event')`);
      expect(tl.count).toBe(1);

      const pv = await step('page_versions INSERT', tx`INSERT INTO page_versions (page_id, compiled_truth)
        VALUES (${aPageId}, 'p12b truth')`);
      expect(pv.count).toBe(1);

      const raw = await step('raw_data INSERT', tx`INSERT INTO raw_data (page_id, source, data)
        VALUES (${aPageId}, 'p12b', ${tx.json({ k: 'p12b' })})`);
      expect(raw.count).toBe(1);

      const take = await step('takes INSERT', tx`INSERT INTO takes (page_id, row_num, claim, kind, holder)
        VALUES (${aPageId}, 999, 'p12b claim', 'prediction', 'b8')`);
      expect(take.count).toBe(1);

      // -- links: both-endpoint WITH CHECK, intra-source -------------------
      const link = await step('links INSERT', tx`INSERT INTO links (from_page_id, to_page_id, link_type)
        VALUES (${aPageId}, ${aPageId}, 'b8_p12b')`);
      expect(link.count).toBe(1);

      // -- pages (the 17th; full CRUD already pinned by P-12) --------------
      const page = await step('pages INSERT', tx`INSERT INTO pages (source_id, slug, type, title)
        VALUES (${A}, 'people/a-p12b', 'person', 'A P12b')`);
      expect(page.count).toBe(1);

      // -- DELETE smoke + cleanup (reverse FK order, same txn) -------------
      const dels: Array<[string, PromiseLike<{ count: number }>]> = [
        ['take_nudge_log', tx`DELETE FROM take_nudge_log WHERE nudge_pattern = 'b8_p12b'`],
        ['take_proposals', tx`DELETE FROM take_proposals WHERE proposal_run_id = 'p12b-run'`],
        ['takes', tx`DELETE FROM takes WHERE page_id = ${aPageId} AND row_num = 999`],
        ['think_ab_results', tx`DELETE FROM think_ab_results WHERE question = 'p12b?'`],
        ['calibration_profiles', tx`DELETE FROM calibration_profiles WHERE model_id = 'p12b-test'`],
        ['query_cache', tx`DELETE FROM query_cache WHERE id = 'b8-p12b'`],
        ['eval_candidates', tx`DELETE FROM eval_candidates WHERE query = 'p12b-q'`],
        ['files', tx`DELETE FROM files WHERE storage_path = 'b8/p12b.txt'`],
        ['ingest_log', tx`DELETE FROM ingest_log WHERE source_ref = 'p12b'`],
        ['raw_data', tx`DELETE FROM raw_data WHERE source = 'p12b'`],
        ['page_versions', tx`DELETE FROM page_versions WHERE compiled_truth = 'p12b truth'`],
        ['timeline_entries', tx`DELETE FROM timeline_entries WHERE summary = 'p12b event'`],
        ['tags', tx`DELETE FROM tags WHERE page_id = ${aPageId} AND tag = 'p12b-tag'`],
        ['content_chunks', tx`DELETE FROM content_chunks WHERE page_id = ${aPageId} AND chunk_index = 99`],
        ['links', tx`DELETE FROM links WHERE link_type = 'b8_p12b'`],
        ['facts', tx`DELETE FROM facts WHERE fact = 'p12b fact v2'`],
        ['pages', tx`DELETE FROM pages WHERE slug = 'people/a-p12b'`],
      ];
      for (const [label, q] of dels) {
        const r = await step(`${label} DELETE`, q);
        expect(r.count).toBe(1);
      }
    });
  });

  test('P-13b replay durability: initSchema replay keeps SECURITY DEFINER + tenant writes alive', async () => {
    // The restart-clobber mechanism: PostgresEngine.initSchema() replays the
    // full embedded schema blob on EVERY engine startup, and CREATE OR REPLACE
    // resets function attributes. Before the source patch, that replay
    // silently stripped any out-of-band ALTER FUNCTION ... SECURITY DEFINER
    // and re-armed the 42501 write lockout. Simulate two restarts over the
    // already-fixed database, then prove the fix survived.
    for (let i = 0; i < 2; i++) {
      const engine = new PostgresEngine();
      await engine.connect({ engine: 'postgres', database_url: DB as string, poolSize: 2 });
      await engine.initSchema();
      await engine.disconnect();
    }

    const [fn] = await admin`
      SELECT prosecdef, proconfig FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'bump_page_generation_clock_fn' AND n.nspname = 'public'`;
    expect(fn).toBeDefined();
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain('search_path=public, pg_temp');

    // The P-12 behavior, now proven durable across replay: tenant DML on its
    // own source still works with the (replayed) statement trigger live.
    await asTenant(A, async (tx) => {
      const ins = await tx`INSERT INTO pages (source_id, slug, type, title)
        VALUES (${A}, 'people/a-replay', 'person', 'A Replay')`;
      expect(ins.count).toBe(1);
      const upd = await tx`UPDATE pages SET title = 'A Replay Renamed' WHERE slug = 'people/a-replay'`;
      expect(upd.count).toBe(1);
      const del = await tx`DELETE FROM pages WHERE slug = 'people/a-replay'`;
      expect(del.count).toBe(1);
    });
  });

  test('P-13d reader read-survival: tenant cached store+lookup survives (page_generation_clock_value)', async () => {
    // The READ-path bug, sibling of the P-13b WRITE-path one. query-cache-gate
    // read page_generation_clock inline as the invoking role. Under gbrain_tenant
    // (no grant on that CAT-6 table) that raised 42501 and aborted the
    // withSourceScope dispatch tx (25P02): the JS try/catch swallowed the error
    // but could not un-abort the tx, so the subsequent real search ran on a dead
    // tx and search_brain/query returned brain_unavailable. The
    // page_generation_clock_value() SECURITY DEFINER reader (PUBLIC EXECUTE) is
    // the fix. This drives the store-time snapshot reads (sites 1+2) AND the
    // lookup gate read (site 3) on a real PostgresEngine connected AS
    // gbrain_tenant, inside the production withSourceScope wrapper. If EXECUTE on
    // the fn is ever revoked from PUBLIC this goes red — remedy: add
    // `GRANT EXECUTE ON FUNCTION page_generation_clock_value() TO gbrain_tenant`
    // to b7-role.sql.

    // Match query_cache.embedding's declared dimension (pgvector encodes the
    // dimension directly in atttypmod), or a mismatched ::vector cast — not the
    // 42501 under test — would be what fails.
    const [{ dim }] = await admin`
      SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'query_cache'::regclass AND attname = 'embedding'`;
    const D = Number(dim) > 0 ? Number(dim) : 1536;
    const emb = (seed: number): Float32Array => {
      const e = new Float32Array(D);
      e[seed % D] = 1;
      return e;
    };
    const META: HybridSearchMeta = {
      vector_enabled: true,
      detail_resolved: 'medium',
      expansion_applied: false,
      intent: 'general',
    };
    const resultWithPage: SearchResult[] = [{
      slug: 'people/a-one',
      page_id: aPageId,
      title: 'A One',
      type: 'person',
      chunk_text: 'alpha chunk',
      chunk_source: 'compiled_truth',
      chunk_id: 1,
      chunk_index: 0,
      score: 1,
      stale: false,
    }];

    const tenantEngine = new PostgresEngine();
    await tenantEngine.connect({ engine: 'postgres', database_url: tenantUrl(DB as string), poolSize: 2 });
    try {
      await tenantEngine.withSourceScope(A, async (e) => {
        const cache = new SemanticQueryCache(e);
        // store() with a real page_id → combined snapshot query (site 2: pages + clock).
        await cache.store('tenant clock survives', emb(1), resultWithPage, META, { sourceId: A });
        // store() with empty results → empty-snapshot branch (site 1: clock only).
        await cache.store('tenant clock survives empty', emb(2), [], META, { sourceId: A });
        // lookup() → CACHE_GATE_WHERE_CLAUSE (site 3: clock read embedded in WHERE).
        const hit = await cache.lookup(emb(1), { sourceId: A });
        // A hit can only happen if the gate's clock read SUCCEEDED. Pre-fix it
        // 42501'd → swallowed → miss, and poisoned the tx.
        expect(hit.hit).toBe(true);
        // And the dispatch tx must NOT be poisoned: a later statement still runs
        // (pre-fix this threw 25P02 "current transaction is aborted").
        const ok = await e.executeRaw<{ ok: number }>(`SELECT 1 AS ok`);
        expect(Number(ok[0]?.ok)).toBe(1);
      });
    } finally {
      await tenantEngine.disconnect();
    }
  });

  test('P-13e writer-fix + forced Layer-2: page_generations stores as a JSONB object and a cache MISS runs jsonb_each without throwing (the path PGLite hides)', async () => {
    // P-13d proved the clock-reader fn survives under the tenant, but its
    // lookup() hit via LAYER 1 — no page write between store and lookup, so the
    // gate's `clock <= max_generation_at_store` short-circuited the OR BEFORE
    // jsonb_each ever ran. The double-encode bug only fires on LAYER 2: a cache
    // MISS where the clock advanced, so the gate evaluates
    // jsonb_each(qc.page_generations). Pre-fix, store() bound page_generations as
    // JSON.stringify(...) into $9::jsonb; postgres.js double-encoded that into a
    // JSONB STRING SCALAR (PGLite parses it back, hiding the bug). jsonb_each on a
    // non-object raises 22023 → aborts the withSourceScope dispatch tx (25P02) →
    // search_brain/query returns brain_unavailable. This drives that exact Layer-2
    // path on real Postgres as gbrain_tenant; Fix B (raw-object bind) is what
    // makes the column an object, and this is its end-to-end proof.
    const [{ dim }] = await admin`
      SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'query_cache'::regclass AND attname = 'embedding'`;
    const D = Number(dim) > 0 ? Number(dim) : 1536;
    // Seed 11 — orthogonal to P-13d's emb(1)/emb(2), so this lookup matches ONLY
    // this row (cosine distance 0 to itself, 1 to those).
    const emb = (seed: number): Float32Array => {
      const e = new Float32Array(D);
      e[seed % D] = 1;
      return e;
    };
    const META: HybridSearchMeta = {
      vector_enabled: true,
      detail_resolved: 'medium',
      expansion_applied: false,
      intent: 'general',
    };
    const resultWithPage: SearchResult[] = [{
      slug: 'people/a-one',
      page_id: aPageId,
      title: 'A One',
      type: 'person',
      chunk_text: 'alpha chunk',
      chunk_source: 'compiled_truth',
      chunk_id: 1,
      chunk_index: 0,
      score: 1,
      stale: false,
    }];
    const QTEXT = 'p13e writer-fix layer2 miss';
    const rowId = cacheRowId(QTEXT, A, '');

    const tenantEngine = new PostgresEngine();
    await tenantEngine.connect({ engine: 'postgres', database_url: tenantUrl(DB as string), poolSize: 2 });
    try {
      await tenantEngine.withSourceScope(A, async (e) => {
        const cache = new SemanticQueryCache(e);

        // 1) store() with a real page → snapshot {aPageId: gen}, bookmark = clock
        //    value at store time (C0).
        await cache.store(QTEXT, emb(11), resultWithPage, META, { sourceId: A });

        // 2) WRITER-FIX PROOF (Fix B): page_generations round-tripped as a JSONB
        //    OBJECT, not the pre-fix string scalar. Read inside this tx — the row
        //    is uncommitted until the block returns, so a separate admin
        //    connection could not see it yet.
        const shape = await e.executeRaw<{ t: string | null }>(
          `SELECT jsonb_typeof(page_generations) AS t FROM query_cache WHERE id = $1`,
          [rowId],
        );
        expect(shape[0]?.t).toBe('object');

        // 3) Force LAYER 2: bump the global page_generation_clock with an
        //    unrelated own-source page INSERT (allowed for the tenant; bumps the
        //    per-statement clock). aPageId is untouched → its stored generation
        //    stays valid, so the gate SERVES the row rather than invalidating it.
        await e.executeRaw(
          `INSERT INTO pages (source_id, slug, type, title)
           VALUES ($1, 'people/p13e-clockbump', 'person', 'Clock Bump')`,
          [A],
        );

        // 4) lookup() now takes the MISS→Layer-2 branch: Layer 1 fails (clock >
        //    C0), so the gate evaluates jsonb_each(page_generations). Pre-fix this
        //    threw on the string scalar; post-fix the object iterates, aPageId
        //    still matches → row served. No throw, rows return.
        const hit = await cache.lookup(emb(11), { sourceId: A });
        expect(hit.hit).toBe(true);

        // 5) results/meta still round-trip — the writer-fix changed ONLY $9
        //    (page_generations); $6/$7 (results/meta) bind unchanged. Pins that
        //    scope claim on the read side.
        expect(hit.results?.[0]?.page_id).toBe(aPageId);
        expect(hit.results?.[0]?.slug).toBe('people/a-one');
        expect(hit.meta?.intent).toBe('general');

        // 6) The dispatch tx is intact — a later statement still runs (pre-fix the
        //    jsonb_each throw left it aborted: 25P02 "current transaction is
        //    aborted" on the next statement).
        const ok = await e.executeRaw<{ ok: number }>(`SELECT 1 AS ok`);
        expect(Number(ok[0]?.ok)).toBe(1);
      });
    } finally {
      await tenantEngine.disconnect();
    }
  });

  test('P-13f shape-guard: a legacy double-encoded (string-scalar) page_generations row invalidates cleanly on forced Layer-2 — no jsonb_each throw, dispatch tx survives', async () => {
    // Fix A defends the rows ALREADY on the box. Every query_cache row the
    // pre-fix store() wrote since v0.40.3.0 carries page_generations as a JSONB
    // STRING SCALAR (the double-encode). Fix B stops NEW bad rows; Fix A keeps the
    // EXISTING ones from crashing search until they age out by TTL (no migration).
    // This reproduces that exact shape and proves the guard: on a forced Layer-2
    // evaluation the row invalidates CLEANLY (clean miss → re-query) instead of
    // raising "cannot call jsonb_each on a non-object" (22023) and poisoning the
    // withSourceScope dispatch tx (25P02 → brain_unavailable).
    const [{ dim }] = await admin`
      SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'query_cache'::regclass AND attname = 'embedding'`;
    const D = Number(dim) > 0 ? Number(dim) : 1536;
    // Seed 17 — orthogonal to P-13d (1,2) and P-13e (11).
    const emb = (seed: number): Float32Array => {
      const e = new Float32Array(D);
      e[seed % D] = 1;
      return e;
    };
    const META: HybridSearchMeta = {
      vector_enabled: true,
      detail_resolved: 'medium',
      expansion_applied: false,
      intent: 'general',
    };
    const resultWithPage: SearchResult[] = [{
      slug: 'people/a-one',
      page_id: aPageId,
      title: 'A One',
      type: 'person',
      chunk_text: 'alpha chunk',
      chunk_source: 'compiled_truth',
      chunk_id: 1,
      chunk_index: 0,
      score: 1,
      stale: false,
    }];
    const QTEXT = 'p13f legacy string-scalar guard';
    const rowId = cacheRowId(QTEXT, A, '');

    const tenantEngine = new PostgresEngine();
    await tenantEngine.connect({ engine: 'postgres', database_url: tenantUrl(DB as string), poolSize: 2 });
    try {
      // 1) Seed a PROPER (post-fix, object-shaped) row via the cache; commits on
      //    block exit so the admin connection below can see + mutate it.
      await tenantEngine.withSourceScope(A, async (e) => {
        await new SemanticQueryCache(e).store(QTEXT, emb(17), resultWithPage, META, { sourceId: A });
      });

      // 2) Rewrite it (admin / BYPASSRLS) into the EXACT pre-fix double-encode
      //    shape: object → its JSON text → wrapped as a JSONB string scalar, the
      //    same shape postgres.js produced from JSON.stringify(...)::jsonb. And
      //    zero the bookmark so Layer 1 ALWAYS fails (clock value on a populated
      //    brain is > 0) → the lookup is deterministically forced into Layer 2.
      const before = await admin`SELECT jsonb_typeof(page_generations) AS t FROM query_cache WHERE id = ${rowId}`;
      expect(before[0]?.t).toBe('object'); // sanity: the fixed writer produced an object
      await admin`UPDATE query_cache
                     SET page_generations = to_jsonb(page_generations::text),
                         max_generation_at_store = 0
                   WHERE id = ${rowId}`;
      const after = await admin`SELECT jsonb_typeof(page_generations) AS t FROM query_cache WHERE id = ${rowId}`;
      expect(after[0]?.t).toBe('string'); // now the legacy crash shape

      // 3) lookup() as gbrain_tenant inside withSourceScope → forced Layer 2 on the
      //    string scalar. jsonb_typeof(page_generations) = 'object' is FALSE, so
      //    the guard short-circuits BEFORE jsonb_each: clean miss, no throw.
      await tenantEngine.withSourceScope(A, async (e) => {
        const hit = await new SemanticQueryCache(e).lookup(emb(17), { sourceId: A });
        expect(hit.hit).toBe(false);
        // Dispatch tx not poisoned — pre-Fix-A the jsonb_each throw left it
        // aborted, and this next statement would raise 25P02.
        const ok = await e.executeRaw<{ ok: number }>(`SELECT 1 AS ok`);
        expect(Number(ok[0]?.ok)).toBe(1);
      });
    } finally {
      await tenantEngine.disconnect();
    }
  });
});

/**
 * P-13a — SOURCE-LEVEL PIN. Deliberately OUTSIDE the GBRAIN_B8_DATABASE_URL
 * gate: it needs no database, so it runs on every `bun test`, everywhere. This
 * is the tripwire that fires at test time — not prod-restart time — when a
 * future upstream merge reintroduces the unsafe (non-SECURITY DEFINER) form of
 * the generation-clock trigger function at any definition site.
 */
describe('P-13a source pin: every bump_page_generation_clock_fn definition is SECURITY DEFINER', () => {
  test('all CREATE OR REPLACE sites in src/ carry SECURITY DEFINER + pinned search_path', () => {
    const SRC = join(import.meta.dir, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|sql)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);

    type Site = { file: string; tail: string };
    const sites: Site[] = [];
    // Matches both the plain form (schema.sql, migrate.ts, pglite-schema.ts)
    // and the escaped-dollar-quoting form in the generated schema-embedded.ts.
    const def = /CREATE OR REPLACE FUNCTION bump_page_generation_clock_fn[\s\S]*?LANGUAGE plpgsql([^;]*);/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(def)) {
        sites.push({ file: file.slice(SRC.length + 1), tail: m[1] });
      }
    }

    // 4 known sites: schema.sql, core/schema-embedded.ts (generated),
    // core/migrate.ts (v107), core/pglite-schema.ts. A drop below 4 means a
    // definition site moved — re-point this pin, don't delete it.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const s of sites) {
      expect(`${s.file}: ${s.tail}`).toMatch(/SECURITY DEFINER/);
      expect(`${s.file}: ${s.tail}`).toMatch(/SET search_path = public, pg_temp/);
    }
  });
});

/**
 * P-13c — READER SOURCE-LEVEL PIN. The read-path sibling of P-13a. Also OUTSIDE
 * the GBRAIN_B8_DATABASE_URL gate: needs no database, runs on every `bun test`.
 * Fires at test time — not prod-restart time — if a future merge reintroduces
 * the unsafe (non-SECURITY DEFINER) form of the page_generation_clock_value()
 * reader at any definition site, which would re-arm the 42501 tenant lockout on
 * the search_brain/query read path (the symptom P-13d exercises live).
 */
describe('P-13c source pin: every page_generation_clock_value definition is SECURITY DEFINER', () => {
  test('all CREATE OR REPLACE sites in src/ carry SECURITY DEFINER + pinned search_path', () => {
    const SRC = join(import.meta.dir, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|sql)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);

    type Site = { file: string; body: string };
    const sites: Site[] = [];
    // The reader is LANGUAGE sql with its attributes BEFORE the dollar-quoted
    // body, and the body holds no semicolons, so match the whole statement up to
    // the terminating `;`. Tolerant of the escaped-dollar form ($ -> \$) the
    // generator emits into schema-embedded.ts.
    const def = /CREATE OR REPLACE FUNCTION page_generation_clock_value[\s\S]*?;/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(def)) {
        sites.push({ file: file.slice(SRC.length + 1), body: m[0] });
      }
    }

    // 4 known sites: schema.sql, core/schema-embedded.ts (generated),
    // core/pglite-schema.ts, core/migrate.ts (v115). A drop below 4 means a
    // definition site moved — re-point this pin, don't delete it.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const s of sites) {
      expect(`${s.file}: ${s.body}`).toMatch(/SECURITY DEFINER/);
      expect(`${s.file}: ${s.body}`).toMatch(/SET search_path = public, pg_temp/);
    }
  });
});
