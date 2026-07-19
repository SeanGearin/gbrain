/**
 * FS-7 (A2 fix-passes 2026-07-18) — graph-construct failure containment,
 * the sibling of the FS-2 materialize guard one block below it in save.ts.
 *
 * The defect class: constructGraphFromClaim ran UNWRAPPED in the insert
 * loop. The graph is a DERIVED layer (stub pages + co_occurrence edges
 * recomputed from claims), but a SQL error inside it:
 *   - tenant plane: aborted the whole withSourceScope dispatch tx (25P02)
 *     — every PRIMARY fact in the batch rolled back over a derived-graph
 *     hiccup, caller sees a hard failure;
 *   - operator auto-commit plane: threw past claims 1..k-1's already-
 *     durably-committed facts — work done with the receipt lost.
 *
 * The fix mirrors FS-2 exactly: engine.transaction() (savepoint inside
 * the dispatch tx, real tx at top level) + honest swallow. Facts commit,
 * receipts stay true, the graph for the poisoned claim is absent until a
 * later save re-runs the idempotent upserts.
 *
 * Induced failure: BEFORE INSERT trigger on pages raising for slugs
 * carrying a sentinel — fires at the entity STUB putPage inside
 * constructGraphFromClaim (a plain-SQL failure inside the graph lane).
 * The poisoned claim's entity also poisons the post-loop materialize's
 * own putPage of that entity page — already savepoint-contained by FS-2,
 * which this test exercises as a bonus (both guards must hold at once).
 *
 * Postgres-only; skips when DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getConn } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSaveFacts } from '../../src/core/facts/save.ts';

const DB = process.env.DATABASE_URL;
const describeE2E = DB ? describe : describe.skip;
if (!DB) {
  console.log('Skipping FS-7 graph-containment e2e (DATABASE_URL not set)');
}

// Slugifies into the stub slug companies/graphbombco-... — the trigger keys
// on the slug substring, so only THIS entity's page writes fail.
const POISON_ENTITY = 'Graphbombco Holdings';
const SOURCES = ['fs7-tenant', 'fs7-operator'];

let engine: PostgresEngine;

describeE2E('save_facts graph-construct failure containment (FS-7)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    const conn = getConn();
    for (const id of SOURCES) {
      await conn.unsafe(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    await conn.unsafe(`
      CREATE OR REPLACE FUNCTION fs7_poison_page() RETURNS trigger AS $$
      BEGIN
        IF NEW.slug LIKE '%graphbombco%' THEN
          RAISE EXCEPTION 'fs7 simulated page constraint failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await conn.unsafe(`DROP TRIGGER IF EXISTS fs7_poison_page_trg ON pages`);
    await conn.unsafe(
      `CREATE TRIGGER fs7_poison_page_trg BEFORE INSERT ON pages
       FOR EACH ROW EXECUTE FUNCTION fs7_poison_page()`,
    );
  });

  afterAll(async () => {
    const conn = getConn();
    await conn.unsafe(`DROP TRIGGER IF EXISTS fs7_poison_page_trg ON pages`);
    await conn.unsafe(`DROP FUNCTION IF EXISTS fs7_poison_page()`);
    await teardownDB();
  });

  async function activeFacts(src: string): Promise<number> {
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND expired_at IS NULL`,
      [src],
    );
    return Number(rows[0].n);
  }

  test('tenant plane: a graph-construct SQL error must not destroy the batch — facts commit, receipt true', async () => {
    const claims = [
      { claim: 'The Q3 vendor summit moved to Porto', provenance: 'user_stated' as const, entities: ['Portside Ventures'] },
      { claim: `${POISON_ENTITY} acquired the Lisbon warehouse operator`, provenance: 'user_stated' as const, entities: [POISON_ENTITY, 'Lisbon Warehouse Co'] },
    ];

    const result = await engine.withSourceScope('fs7-tenant', (scoped) =>
      runSaveFacts(claims, { engine: scoped, sourceId: 'fs7-tenant' }),
    );
    if ('error' in result) throw new Error(`unexpected validation error: ${JSON.stringify(result)}`);

    // Both PRIMARY facts committed with a true receipt.
    expect(result.inserted).toBe(2);
    expect(result.results[0].status).toBe('inserted');
    expect(result.results[1].status).toBe('inserted');
    expect(await activeFacts('fs7-tenant')).toBe(2);

    // The poisoned claim's graph is absent (stub blocked by the trigger);
    // the clean claim's stub exists — containment was per-claim.
    const conn = getConn();
    const poisoned = await conn.unsafe(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'fs7-tenant' AND slug LIKE '%graphbombco%'`,
    );
    expect(Number(poisoned[0].n)).toBe(0);
    const clean = await conn.unsafe(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'fs7-tenant' AND slug LIKE '%portside%'`,
    );
    expect(Number(clean[0].n)).toBeGreaterThan(0);
  });

  test('operator plane: a mid-batch graph error must not lose the receipt for committed work', async () => {
    const claims = [
      { claim: 'Marlowe drafts the pricing addendum on Fridays', provenance: 'user_stated' as const, people: ['Marlowe'] },
      { claim: `${POISON_ENTITY} filed the second amendment`, provenance: 'user_stated' as const, entities: [POISON_ENTITY] },
      { claim: 'The addendum review board meets monthly', provenance: 'user_stated' as const },
    ];

    // Auto-commit plane: no withSourceScope wrapper.
    const result = await runSaveFacts(claims, { engine, sourceId: 'fs7-operator' });
    if ('error' in result) throw new Error(`unexpected validation error: ${JSON.stringify(result)}`);

    // Pre-fix this line was never reached — the graph throw escaped after
    // claim 1 (and claim 2's fact) had already durably committed.
    expect(result.inserted).toBe(3);
    expect(result.results.map((r) => r.status)).toEqual(['inserted', 'inserted', 'inserted']);
    expect(await activeFacts('fs7-operator')).toBe(3);
  });
});
