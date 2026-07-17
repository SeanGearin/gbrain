/**
 * FS-2 (engine audit 2026-07-17) — materialize failure containment on the
 * tenant withSourceScope tx plane.
 *
 * The defect class: save_facts wraps the post-loop materializeEntityPages in a
 * try/catch that swallows and logs "materialize skipped (facts saved)". On the
 * operator/CLI auto-commit plane that is correct — the facts were durably
 * committed by insertFact before materialize ran. But on the remote-dispatch
 * plane, serve-http runs the WHOLE op inside engine.withSourceScope's
 * transaction (postgres-engine.ts:923): a materialize SQL error there aborts
 * the dispatch tx (25P02). The swallow let runSaveFacts return its success
 * tally anyway; postgres.js's begin-scope error backstop (uncaughtError,
 * postgres@3.4.9 src/index.js scope()) then re-threw the swallowed query error
 * after the op resolved — so the caller received a FAILURE and every fact in
 * the batch was rolled back. Net: a derived-layer rebuild hiccup (the entity
 * body recompile) silently destroyed the batch's PRIMARY writes, while the
 * server log claimed "facts saved". On a postgres.js without that backstop the
 * same shape is worse: the success tally would reach the caller for rows that
 * no longer exist (the fabricated receipt named in the audit).
 *
 * The fix: run materializeEntityPages inside ctx.engine.transaction(), the
 * engine's plane-aware nesting primitive — a real transaction at top level,
 * a SAVEPOINT when already inside the withSourceScope dispatch tx. A
 * materialize failure rolls back ONLY the materialize writes; the facts (+
 * graph stubs) commit, the receipt is true, and the next save re-materializes
 * (the facts→body compile is idempotent over the fact set).
 *
 * Postgres-only (the tenant tx plane does not exist on PGLite — its
 * withSourceScope is a pass-through). Gated on DATABASE_URL like the rest of
 * test/e2e; skips gracefully when unset.
 *
 * The induced failure is a BEFORE INSERT trigger on content_chunks that raises
 * for chunk text carrying a sentinel token — the same in-tx plain-SQL failure
 * class the audit named (constraint/size/timeout during the chunk rewrite).
 * The sentinel appears only in the poisoned claim's text, so it fires during
 * materialize Phase 3 (the compiled body contains the claim text), never
 * during the insert loop's stub-chunk writes (stub bodies don't include claim
 * text).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getConn } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSaveFacts } from '../../src/core/facts/save.ts';

const DB = process.env.DATABASE_URL;
const describeE2E = DB ? describe : describe.skip;
if (!DB) {
  console.log('Skipping FS-2 materialize-containment e2e (DATABASE_URL not set)');
}

const SENTINEL = 'FS2POISONSENTINEL';
const SOURCES = ['fs2-tenant', 'fs2-operator', 'fs2-clean'];

let engine: PostgresEngine;

describeE2E('save_facts materialize failure containment (FS-2)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    const conn = getConn();
    for (const id of SOURCES) {
      await conn.unsafe(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    // Deterministic in-tx SQL failure during materialize Phase 3.
    await conn.unsafe(`
      CREATE OR REPLACE FUNCTION fs2_poison_chunk() RETURNS trigger AS $$
      BEGIN
        IF NEW.chunk_text LIKE '%${SENTINEL}%' THEN
          RAISE EXCEPTION 'fs2 simulated chunk constraint failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await conn.unsafe(`DROP TRIGGER IF EXISTS fs2_poison_chunk_trg ON content_chunks`);
    await conn.unsafe(
      `CREATE TRIGGER fs2_poison_chunk_trg BEFORE INSERT ON content_chunks
       FOR EACH ROW EXECUTE FUNCTION fs2_poison_chunk()`,
    );
  });

  afterAll(async () => {
    const conn = getConn();
    await conn.unsafe(`DROP TRIGGER IF EXISTS fs2_poison_chunk_trg ON content_chunks`);
    await conn.unsafe(`DROP FUNCTION IF EXISTS fs2_poison_chunk()`);
    await teardownDB();
  });

  test('tenant plane: a materialize SQL error must not destroy the batch — facts commit, receipt true', async () => {
    const claim = {
      claim: `Acmeflux ${SENTINEL} is negotiating a warehouse lease`,
      entities: ['Acmeflux'],
      provenance: 'user_stated' as const,
    };

    // The serve-http dispatch shape (serve-http.ts:2205): the whole op inside
    // withSourceScope's tx. Pre-fix this REJECTS (postgres.js re-throws the
    // swallowed chunk error) and the facts roll back — the red state.
    const result = await engine.withSourceScope('fs2-tenant', (scoped) =>
      runSaveFacts([claim], { engine: scoped, sourceId: 'fs2-tenant' }),
    );

    // Receipt shape + tally.
    if ('error' in result) throw new Error(`unexpected validation error: ${JSON.stringify(result)}`);
    expect(result.inserted).toBe(1);
    expect(result.fact_ids.length).toBe(1);
    expect(result.results[0]).toEqual({ index: 0, status: 'inserted', fact_id: result.fact_ids[0] });

    // The honest-receipt invariant, read POST-tx on a fresh connection: every
    // fact_id the receipt claims must exist as a committed row.
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT id, fact FROM facts WHERE source_id = 'fs2-tenant' AND id = $1`,
      [result.fact_ids[0]],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].fact)).toContain(SENTINEL);

    // The graph stub (written in the insert loop, BEFORE the savepoint) also
    // survives; the materialize rewrite itself was rolled back — the compiled
    // body never took the fact text and no sentinel chunk was committed.
    const pages = await conn.unsafe(
      `SELECT compiled_truth FROM pages WHERE source_id = 'fs2-tenant' AND slug = 'companies/acmeflux'`,
    );
    expect(pages.length).toBe(1);
    expect(String(pages[0].compiled_truth)).not.toContain(SENTINEL);
    const poisonChunks = await conn.unsafe(
      `SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id
       WHERE p.source_id = 'fs2-tenant' AND c.chunk_text LIKE '%${SENTINEL}%'`,
    );
    expect(poisonChunks.length).toBe(0);
  });

  test('operator plane control: auto-commit swallow keeps its honest tally on a materialize failure', async () => {
    const claim = {
      claim: `Acmeflux ${SENTINEL} hired a logistics manager`,
      entities: ['Acmeflux'],
      provenance: 'user_stated' as const,
    };

    // No withSourceScope — the operator/CLI plane. insertFact commits its own
    // tx; the materialize failure must stay swallowed and the tally honest.
    const result = await runSaveFacts([claim], { engine, sourceId: 'fs2-operator' });

    if ('error' in result) throw new Error(`unexpected validation error: ${JSON.stringify(result)}`);
    expect(result.inserted).toBe(1);

    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT id FROM facts WHERE source_id = 'fs2-operator' AND id = $1`,
      [result.fact_ids[0]],
    );
    expect(rows.length).toBe(1);
  });

  test('tenant plane happy path: materialize succeeds inside the guard — compiled body + chunks land', async () => {
    const claim = {
      claim: 'Acmeflux opened a Lisbon office in March',
      entities: ['Acmeflux'],
      provenance: 'user_stated' as const,
    };

    const result = await engine.withSourceScope('fs2-clean', (scoped) =>
      runSaveFacts([claim], { engine: scoped, sourceId: 'fs2-clean' }),
    );

    if ('error' in result) throw new Error(`unexpected validation error: ${JSON.stringify(result)}`);
    expect(result.inserted).toBe(1);

    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT id FROM facts WHERE source_id = 'fs2-clean' AND id = $1`,
      [result.fact_ids[0]],
    );
    expect(rows.length).toBe(1);

    // Materialize committed: the entity body was rebuilt from the fact and
    // re-chunked with real substance.
    const pages = await conn.unsafe(
      `SELECT compiled_truth FROM pages WHERE source_id = 'fs2-clean' AND slug = 'companies/acmeflux'`,
    );
    expect(pages.length).toBe(1);
    expect(String(pages[0].compiled_truth)).toContain('Lisbon office');
    const chunks = await conn.unsafe(
      `SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id
       WHERE p.source_id = 'fs2-clean' AND c.chunk_text LIKE '%Lisbon office%'`,
    );
    expect(chunks.length).toBeGreaterThan(0);
  });
});
