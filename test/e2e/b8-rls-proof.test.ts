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
 *   P-11 auth-bootstrap grants are RLS-dead under the tenant role: SELECT on
 *        oauth_clients/access_tokens returns 0 rows, NOT an error (the tables
 *        are RLS-enabled with no policy; reads ride the privileged pool in
 *        production — pins the vestigial-grant finding)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { execSync } from 'child_process';
import { join } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

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

/** The 18 tables sql/b7-policies.sql row-scopes, by category. */
const CAT1 = ['pages', 'ingest_log', 'files', 'facts', 'calibration_profiles',
  'take_proposals', 'take_nudge_log', 'think_ab_results', 'query_cache'];
const CAT2 = ['content_chunks', 'tags', 'timeline_entries', 'page_versions', 'raw_data', 'takes'];
const POLICED = [...CAT1, ...CAT2, 'links', 'eval_candidates', 'sources'];

/** CAT-6 infra: no grant to gbrain_tenant -> permission denied on first touch. */
const CAT6_PROBE = ['minion_jobs', 'config', 'gbrain_cycle_locks', 'mcp_request_log',
  'dream_verdicts', 'subagent_messages', 'access_tokens_is_select_only_see_P11'];

/** Tables granted SELECT-only for auth bootstrap (b7-role.sql Step 2c). */
const BOOTSTRAP_SELECT_ONLY = ['sources', 'oauth_clients', 'oauth_tokens', 'oauth_codes', 'access_tokens'];

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
    // Forward-compat fix for the v107 statement-level generation-clock trigger
    // (see sql/b7-fix-generation-clock.sql — found by this suite). No-op on
    // pre-v107 schemas. Without it, every tenant pages write 42501s inside the
    // trigger and P-2/P-7/P-12 fail.
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
    expect(rows.length).toBe(18);
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

  test('P-11 auth-bootstrap SELECT grants are RLS-dead under the tenant (0 rows, no error)', async () => {
    // oauth_clients / access_tokens are RLS-ENABLED with NO policy. The tenant
    // role holds a SELECT grant (b7-role.sql Step 2c) but default-deny RLS
    // yields zero rows — the grant cannot leak; production auth reads ride the
    // privileged pool. Pins the vestigial-grant audit finding.
    for (const tbl of ['oauth_clients', 'oauth_tokens', 'oauth_codes', 'access_tokens']) {
      const rows = await asTenant(A, (tx) => tx.unsafe(`SELECT count(*)::int AS n FROM ${tbl}`));
      expect(Number(rows[0].n)).toBe(0);
    }
  });
});
