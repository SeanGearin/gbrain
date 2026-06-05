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
import { execSync } from 'child_process';
import { join } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { makeIngestCaptureHandler } from '../../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import type { IngestionEvent } from '../../src/core/ingestion/types.ts';

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
// The database to apply the shipped .sql into — the path component of the admin
// DSN (e.g. .../gbrain_e2e_scratch -> gbrain_e2e_scratch). Empty when DB unset
// (the whole suite skips in that case, so applyFile is never reached).
const DB_NAME = DB ? new URL(DB).pathname.replace(/^\//, '') : '';

/** Derive the gbrain_tenant connection URL from the admin DB URL (swap userinfo). */
function tenantUrl(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = 'gbrain_tenant';
  u.password = TENANT_PW;
  return u.toString();
}

/**
 * Apply a shipped .sql file the SAME way production does: hand it to psql.
 *
 *   sudo -u postgres psql -v ON_ERROR_STOP=1 -d <db> [-v tenant_password=...] < <file>
 *
 * The file is fed via STDIN, not `-f <file>`. With `-f`, psql itself opens the
 * path — and psql runs as the postgres OS user under sudo, which cannot
 * traverse a mode-750 /home/<user> (Ubuntu 24.04 default), so it gets
 * "Permission denied" on a file under the invoking user's home. The `<` redirect
 * is opened by the invoking shell (which owns the file); psql consumes stdin
 * identically — \if/\echo/\endif meta-commands and -v vars all apply.
 *
 * Running through real psql as the cluster superuser is what makes this test's
 * apply path byte-identical to production's. psql parses the shipped files
 * natively — the \if/\echo/\endif meta-commands, the DO $$...$$ blocks, the
 * BEGIN/COMMIT framing, and the :'tenant_password' variable interpolation all
 * execute as written. No client-side reimplementation, no line stripping, no
 * dependency on the gbrain role's privileges (CREATE ROLE / ALTER ROLE run as
 * the superuser, not over the admin TCP connection). The tenant_password var
 * is supplied only for b7-role.sql; the other files don't reference it.
 *
 * On non-zero exit, psql's stderr is folded into the thrown error so a failing
 * apply names the offending statement instead of a bare exit code.
 */
function applyFile(file: string, opts?: { tenantPassword?: string }): void {
  const varFlag = opts?.tenantPassword
    ? ` -v tenant_password=${opts.tenantPassword}`
    : '';
  const cmd =
    `sudo -u postgres psql -v ON_ERROR_STOP=1 -d ${DB_NAME}` +
    `${varFlag} < ${join(SQL_DIR, file)}`;
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`applyFile(${file}) failed: ${detail}`);
  }
}

describeE2E('B7 RLS backstop (real Postgres + gbrain_tenant)', () => {
  let admin: postgres.Sql;          // incumbent / superuser (BYPASSRLS)
  let tenant: postgres.Sql;         // raw gbrain_tenant connection (Layer 1)
  let tenantEngine: PostgresEngine; // real engine as gbrain_tenant (Layer 2)
  let adminEngine: PostgresEngine;  // real engine as incumbent/BYPASSRLS (Layer 3 — D-INT-1/-2)
  let aPageId = 0;
  let bPageId = 0;
  let enqueuedJobId = 0;            // the ingest_capture row T-INT-1 enqueues (cleaned in afterAll)

  beforeAll(async () => {
    admin = postgres(DB as string, { prepare: false, max: 4 });

    // Step 1 — policies (dormant under the BYPASSRLS admin role).
    applyFile('b7-policies.sql');

    // Step 2 — role + grants. The shipped file's final step is
    //   ALTER ROLE gbrain_tenant WITH LOGIN PASSWORD :'tenant_password'
    // guarded by \if :{?tenant_password}; psql sets LOGIN from the var we pass.
    applyFile('b7-role.sql', { tenantPassword: TENANT_PW });

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

    // Layer 3 (D-INT-1/-2) uses a real engine on the INCUMBENT/BYPASSRLS DSN —
    // the "privileged" plane: serve-http's privilegedEngine for the /ingest
    // enqueue (D-INT-1) and the `gbrain jobs work` consumer that runs the
    // ingest_capture handler (D-INT-4 places it on this role precisely because
    // it must write any tenant's pages without RLS confinement).
    //
    // poolSize forces PostgresEngine.connect down the INSTANCE-pool path
    // (postgres-engine.ts:127 — its own postgres() client) instead of the
    // process-wide module singleton. tenantEngine above took the singleton
    // (tenant URL); without poolSize this connect() would see that singleton
    // already open and silently REUSE the tenant-role connection, so the
    // "admin" engine would be RLS-confined and admin work (config read in
    // MinionQueue.ensureSchema, putPage in importFromContent) would be denied.
    // The instance pool is owned by this engine, on the scratch GBRAIN_DATABASE_URL
    // the test received — never a prod DSN — and disconnect() tears it down
    // without touching the module singleton (postgres-engine.ts:196).
    adminEngine = new PostgresEngine();
    await adminEngine.connect({ engine: 'postgres', database_url: DB as string, poolSize: 2 });
  });

  afterAll(async () => {
    try { await tenantEngine?.disconnect(); } catch { /* noop */ }
    // minion_jobs has no source FK, so the ingest_capture row T-INT-1 enqueued
    // won't cascade with the sources delete — drop it explicitly through the
    // admin ENGINE (the same incumbent-role instance pool that enqueued it),
    // while it is still connected and before we disconnect it.
    if (adminEngine && enqueuedJobId) {
      try { await adminEngine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [enqueuedJobId]); } catch { /* noop */ }
    }
    try { await adminEngine?.disconnect(); } catch { /* noop */ }
    try { await tenant?.end({ timeout: 5 }); } catch { /* noop */ }
    if (admin) {
      // Remove only our seed rows (cascade clears chunks/facts/links), then the
      // role + policies via the shipped rollback. Order: data -> rollback.
      try {
        await admin`DELETE FROM sources WHERE id IN (${A}, ${B})`;
      } catch { /* noop */ }
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
    // A distinct link_type means this (from,to,type,source,origin) tuple is never
    // seeded, so the unique constraint cannot fire — the ONLY possible rejection
    // is the RLS WITH CHECK policy. Assert that specifically (42501 / row-level
    // security), not a bare "throws" that a 23505 duplicate could satisfy.
    let xEdgeErr: { code?: string; message?: string } | undefined;
    try {
      await asTenant(A, (tx) => tx`INSERT INTO links (from_page_id, to_page_id, link_type)
        VALUES (${aPageId}, ${bPageId}, ${'b7_xsource_forbidden'})`);
    } catch (e) {
      xEdgeErr = e as { code?: string; message?: string };
    }
    expect(xEdgeErr?.code).toBe('42501'); // RLS WITH CHECK, not 23505 unique
    expect(xEdgeErr?.message).toMatch(/row-level security/i);
    // The same shape with both endpoints in A is allowed. Distinct link_type so
    // it can't collide with the seeded (aPageId,aPageId,'') edge on the unique key.
    await asTenant(A, async (tx) => {
      const ins = await tx`INSERT INTO links (from_page_id, to_page_id, link_type)
        VALUES (${aPageId}, ${aPageId}, ${'b7_intra_ok'})`;
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

  // ===================== Layer 3 — integration fixes (D-INT-1/-2) ============
  //
  // These pin the two gbrain-fork code changes the worker↔endpoint integration
  // needs against the SAME real-Postgres + gbrain_tenant rig. They are the
  // teeth for the flip: D-INT-1 keeps /ingest from 500ing the moment the tenant
  // pool is wired; D-INT-2 keeps a tenant's ingested page off Sean's brain.

  /**
   * A valid IngestionEvent sealed to `sourceId` — the shape the B2 write-seal
   * produces at POST /ingest from the token's authorized source.
   */
  function syntheticEvent(sourceId: string): IngestionEvent {
    return {
      source_id: sourceId,
      source_kind: 'webhook',
      source_uri: 'test://b7/int',
      received_at: new Date().toISOString(),
      content_type: 'text/markdown',
      content: '# Tenant Capture\n\nSealed-source ingest body for the D-INT-2 proof.',
      content_hash: 'a'.repeat(64),
      untrusted_payload: true,
    };
  }

  test('T-INT-1 (D-INT-1) privileged enqueue lands a minion_jobs row; tenant role is permission-denied', async () => {
    // Privileged plane (incumbent/BYPASSRLS) enqueues via MinionQueue — exactly
    // what serve-http /ingest now does (the shared ingestQueue is bound to
    // privilegedEngine). The row lands.
    const job = await new MinionQueue(adminEngine).add(
      'ingest_capture',
      { event: syntheticEvent(A) },
      { idempotency_key: 'b7test:enqueue-seam', maxWaiting: 50 },
    );
    enqueuedJobId = Number(job.id);
    expect(enqueuedJobId).toBeGreaterThan(0);
    const [row] = await admin`SELECT name FROM minion_jobs WHERE id = ${enqueuedJobId}`;
    expect(row?.name).toBe('ingest_capture');

    // The same write through the tenant (NOBYPASSRLS) role is denied at the
    // GRANT layer — minion_jobs is CAT-6 with no gbrain_tenant grant. This is
    // the exact failure D-INT-1 routes around by enqueuing on privilegedEngine.
    await expect(
      asTenant(A, (tx) => tx`INSERT INTO minion_jobs (name) VALUES ('ingest_capture')`),
    ).rejects.toThrow(/permission denied/i);
  });

  test('T-INT-2 (D-INT-2) ingest_capture writes the sealed source, not default', async () => {
    // The consumer runs on the incumbent/BYPASSRLS engine (D-INT-4 places it
    // there so it can write any tenant's pages). With the D-INT-2 fix it threads
    // event.source_id into importFromContent, so the deferred page write lands
    // on the SEALED source — not 'default' (Sean's brain), which is where every
    // tenant's page landed before the fix.
    const handler = makeIngestCaptureHandler(adminEngine);
    const job = { data: { event: syntheticEvent(A) } } as unknown as MinionJobContext;
    const result = await handler(job);
    expect(result.status).toBe('imported');

    const [page] = await admin`SELECT source_id FROM pages WHERE slug = ${result.slug}`;
    expect(page?.source_id).toBe(A);
    expect(page?.source_id).not.toBe('default');
  });
});
