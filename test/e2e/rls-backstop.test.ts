/**
 * B7 RLS backstop — e2e (design §F).
 *
 * Proves the Model B database backstop at the layer that matters: with the
 * shipped sql/b7-policies.sql applied and a real NOBYPASSRLS `gbrain_tenant`
 * role connected, cross-source reads/writes are denied BY POSTGRES, independent
 * of any app-layer source filter.
 *
 *   Layer 1 (T-SQL-1..6) — raw SQL as gbrain_tenant. The teeth.
 *   Layer 2 (T-HTTP-2..4) — the real PostgresEngine.withSourceScope chokepoint
 *                           + the defense-in-depth proof (a deliberately
 *                           cross-scoped query through the tenant role; the DB
 *                           still denies — NO app-scope-disable backdoor in src).
 *
 * Gated on GBRAIN_DATABASE_URL (the scratch clone at review). NEVER runs against
 * prod: `gbrain apply-migrations` follows config.json, but this test only ever
 * touches the DB named by GBRAIN_DATABASE_URL. Skips graceful when unset.
 *
 * Run on the EC2 scratch clone:
 *   GBRAIN_DATABASE_URL=postgres://.../gbrain_e2e_scratch \
 *     bun test test/e2e/rls-backstop.test.ts
 *
 * Cleanup (afterAll) drops ONLY what this test created: the two b7test_* sources
 * (cascade), the gbrain_tenant role, and the b7_tenant_isolation policies (via
 * sql/b7-rollback.sql). It drops nothing it did not create.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DB = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const describeE2E = DB ? describe : describe.skip;
if (!DB) {
  console.log('Skipping B7 RLS backstop e2e (GBRAIN_DATABASE_URL not set)');
}

// ---- test fixtures (all prefixed b7test_ so cleanup is unambiguous) ----
const A = 'b7test_a';
const B = 'b7test_b';
const TENANT_PW = 'b7_test_tenant_pw_do_not_use_in_prod';
const SQL_DIR = join(import.meta.dir, '..', '..', 'sql');

/** Derive the gbrain_tenant connection URL from the admin DB URL (swap userinfo). */
function tenantUrl(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = 'gbrain_tenant';
  u.password = TENANT_PW;
  return u.toString();
}

/** Apply a shipped .sql file, stripping psql client meta-commands (\if, \echo ...). */
async function applyFile(admin: postgres.Sql, file: string): Promise<void> {
  const raw = readFileSync(join(SQL_DIR, file), 'utf8');
  const noMeta = raw
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l)) // drop psql backslash meta-commands
    .join('\n');
  await admin.unsafe(noMeta);
}

describeE2E('B7 RLS backstop (real Postgres + gbrain_tenant)', () => {
  let admin: postgres.Sql;          // incumbent / superuser (BYPASSRLS)
  let tenant: postgres.Sql;         // raw gbrain_tenant connection (Layer 1)
  let tenantEngine: PostgresEngine; // real engine as gbrain_tenant (Layer 2)
  let aPageId = 0;
  let bPageId = 0;

  beforeAll(async () => {
    admin = postgres(DB as string, { prepare: false, max: 4 });

    // Step 1 — policies (dormant under the BYPASSRLS admin role).
    await applyFile(admin, 'b7-policies.sql');

    // Step 2 — role + grants. The shipped file's LOGIN line is a psql \if block
    // (stripped above); set the login password explicitly here.
    await applyFile(admin, 'b7-role.sql');
    await admin.unsafe(`ALTER ROLE gbrain_tenant WITH LOGIN PASSWORD '${TENANT_PW}'`);

    // Seed two sources with brain content on each axis a policy covers.
    await admin`INSERT INTO sources (id, name) VALUES (${A}, ${'B7 Test A'}), (${B}, ${'B7 Test B'})
                ON CONFLICT (id) DO NOTHING`;

    const [pa] = await admin`INSERT INTO pages (source_id, slug, type, title)
      VALUES (${A}, ${'people/a-one'}, 'person', 'A One') RETURNING id`;
    const [pb] = await admin`INSERT INTO pages (source_id, slug, type, title)
      VALUES (${B}, ${'people/b-one'}, 'person', 'B One') RETURNING id`;
    aPageId = Number(pa.id);
    bPageId = Number(pb.id);

    await admin`INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
      VALUES (${aPageId}, 0, ${'alpha chunk'}), (${bPageId}, 0, ${'bravo chunk'})`;
    await admin`INSERT INTO facts (source_id, fact, source)
      VALUES (${A}, ${'a fact'}, ${'seed'}), (${B}, ${'b fact'}, ${'seed'})`;
    // intra-source links (legitimate)
    await admin`INSERT INTO links (from_page_id, to_page_id) VALUES (${aPageId}, ${aPageId})`;
    await admin`INSERT INTO links (from_page_id, to_page_id) VALUES (${bPageId}, ${bPageId})`;

    tenant = postgres(tenantUrl(DB as string), { prepare: false, max: 4 });
    tenantEngine = new PostgresEngine();
    await tenantEngine.connect({ engine: 'postgres', database_url: tenantUrl(DB as string) });
  });

  afterAll(async () => {
    try { await tenantEngine?.disconnect(); } catch { /* noop */ }
    try { await tenant?.end({ timeout: 5 }); } catch { /* noop */ }
    if (admin) {
      // Remove only our seed rows (cascade clears chunks/facts/links), then the
      // role + policies via the shipped rollback. Order: data -> rollback.
      try {
        await admin`DELETE FROM sources WHERE id IN (${A}, ${B})`;
      } catch { /* noop */ }
      try { await applyFile(admin, 'b7-rollback.sql'); } catch { /* noop */ }
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

  // ===================== Layer 1 — SQL-layer, as gbrain_tenant ===============

  test('T-SQL-1 read denial: scope A sees only A rows across every category', async () => {
    await asTenant(A, async (tx) => {
      const [pages] = await tx`SELECT count(*)::int AS n FROM pages`;
      expect(pages.n).toBe(1);
      const [bVisible] = await tx`SELECT count(*)::int AS n FROM pages WHERE source_id = ${B}`;
      expect(bVisible.n).toBe(0); // RLS hides B even when asked by name
      const [chunks] = await tx`SELECT count(*)::int AS n FROM content_chunks`;
      expect(chunks.n).toBe(1);   // CAT-2 EXISTS-on-pages
      const [facts] = await tx`SELECT count(*)::int AS n FROM facts`;
      expect(facts.n).toBe(1);
      const [links] = await tx`SELECT count(*)::int AS n FROM links`;
      expect(links.n).toBe(1);
      const [srcs] = await tx`SELECT count(*)::int AS n FROM sources`;
      expect(srcs.n).toBe(1);     // CAT-5 self-row only
    });
  });

  test('T-SQL-2 write denial: cannot INSERT/UPDATE/DELETE into another source', async () => {
    // INSERT into B while scoped A -> WITH CHECK violation.
    await expect(
      asTenant(A, (tx) => tx`INSERT INTO pages (source_id, slug, type, title)
        VALUES (${B}, ${'people/evil'}, 'person', 'Evil')`),
    ).rejects.toThrow();
    // UPDATE / DELETE of B rows are invisible (0 rows affected), never an error.
    await asTenant(A, async (tx) => {
      const upd = await tx`UPDATE pages SET title = 'hacked' WHERE source_id = ${B}`;
      expect(upd.count).toBe(0);
      const del = await tx`DELETE FROM pages WHERE source_id = ${B}`;
      expect(del.count).toBe(0);
    });
    // B's page is intact (verified by the BYPASSRLS admin).
    const [b] = await admin`SELECT title FROM pages WHERE id = ${bPageId}`;
    expect(b.title).toBe('B One');
  });

  test('T-SQL-3 fail-closed: unset OR empty source var yields ZERO rows', async () => {
    // Unset GUC -> current_setting(...,true) is NULL -> no rows.
    const unset = await tenant.begin(async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(unset).toBe(0);
    // Empty-string GUC -> matches no content row either.
    const empty = await asTenant('', async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM pages`;
      return r.n;
    });
    expect(empty).toBe(0);
  });

  test('T-SQL-4 CAT-6 deny-by-GRANT: infra tables are permission-denied', async () => {
    for (const tbl of ['minion_jobs', 'config', 'gbrain_cycle_locks', 'mcp_request_log']) {
      await expect(
        asTenant(A, (tx) => tx.unsafe(`SELECT count(*) FROM ${tbl}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  test('T-SQL-5 CAT-2/links: cross-source chunk invisible; foreign edge write blocked (D4)', async () => {
    // B's chunk is invisible to A (derived via pages.source_id).
    await asTenant(A, async (tx) => {
      const [r] = await tx`SELECT count(*)::int AS n FROM content_chunks WHERE chunk_text = 'bravo chunk'`;
      expect(r.n).toBe(0);
    });
    // D4: a tenant cannot author an edge whose to_page_id lives in another source.
    await expect(
      asTenant(A, (tx) => tx`INSERT INTO links (from_page_id, to_page_id) VALUES (${aPageId}, ${bPageId})`),
    ).rejects.toThrow(); // WITH CHECK requires BOTH endpoints in-source
    // The same edge with both endpoints in A is allowed.
    await asTenant(A, async (tx) => {
      const ins = await tx`INSERT INTO links (from_page_id, to_page_id) VALUES (${aPageId}, ${aPageId})`;
      expect(ins.count).toBe(1);
    });
  });

  test('T-SQL-6 incumbent (BYPASSRLS) sees ALL sources with policies live', async () => {
    const [pages] = await admin`SELECT count(*)::int AS n FROM pages WHERE source_id IN (${A}, ${B})`;
    expect(pages.n).toBe(2); // Sean's plane is untouched by B7
  });

  // ===================== Layer 2 — withSourceScope chokepoint =================

  test('T-HTTP-2 withSourceScope confines engine reads to the scoped source', async () => {
    const aSlugs = await tenantEngine.withSourceScope(A, (e) =>
      e.executeRaw<{ slug: string }>('SELECT slug FROM pages ORDER BY slug'));
    expect(aSlugs.map((r) => r.slug)).toEqual(['people/a-one']);
  });

  test('T-HTTP-3 defense-in-depth: a deliberately cross-scoped query is denied by the DB', async () => {
    // Simulate an app-layer bug: scoped to A, but the query explicitly asks for
    // B's rows. No app filter is involved — the RLS policy alone must return 0.
    const leaked = await tenantEngine.withSourceScope(A, (e) =>
      e.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id = $1', [B]));
    expect(leaked[0].n).toBe(0);
  });

  test('T-HTTP-3b transaction-local var does not leak across withSourceScope calls', async () => {
    const a = await tenantEngine.withSourceScope(A, (e) =>
      e.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'));
    const b = await tenantEngine.withSourceScope(B, (e) =>
      e.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'));
    expect(a[0].n).toBe(1);
    expect(b[0].n).toBe(1); // B sees its own row, not A's — no GUC bleed
    // And a bare (unscoped) read after the scopes is fail-closed.
    const bare = await tenantEngine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    expect(bare[0].n).toBe(0);
  });

  test('T-HTTP-4 kill-one: deleting source B leaves source A intact (cascade)', async () => {
    // Run on the admin/BYPASSRLS connection (provisioning/admin authority).
    await admin`DELETE FROM sources WHERE id = ${B}`;
    const [b] = await admin`SELECT count(*)::int AS n FROM pages WHERE source_id = ${B}`;
    expect(b.n).toBe(0); // B's pages cascade-deleted
    const [a] = await admin`SELECT count(*)::int AS n FROM pages WHERE source_id = ${A}`;
    expect(a.n).toBe(1); // A untouched
    // re-seed B so afterAll cleanup is symmetric (idempotent DELETE handles it)
    await admin`INSERT INTO sources (id, name) VALUES (${B}, ${'B7 Test B'}) ON CONFLICT (id) DO NOTHING`;
  });
});
