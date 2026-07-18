/**
 * A2 fix-passes (2026-07-18) — FS-8 class: the save_facts dedup window
 * under REAL concurrency. Pre-fix, two concurrent same-text saves both
 * missed dedup and both inserted in every plane shape — including WITH
 * the per-entity advisory lock, because callers ran the dedup check
 * BEFORE the lock was acquired (probe receipt in
 * sessions/cc-findings_2026-07-18_engine-A2-fix-passes.md). Post-fix the
 * plain insert path locks every insert (entity key, else folded-text
 * key) and re-runs the exact-arm check INSIDE the lock, so the loser
 * lands as status 'duplicate' pointing at the winner's row.
 *
 * Four-way parallel saves make the pre-fix red near-certain (the probe
 * hit it 3/3 with only two writers). Post-fix the outcome is
 * deterministic: exactly one active row, exactly one 'inserted' receipt.
 *
 * Skips gracefully when DATABASE_URL is unset (needs real multi-
 * connection Postgres; PGLite cannot race).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../../src/core/facts/save.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  test.skip('facts-concurrent-dedup postgres twin skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('save_facts concurrent dedup window against real Postgres', () => {
  const engines: PostgresEngine[] = [];
  const WRITERS = 4;

  const SOURCES = ['a2conc-entity', 'a2conc-noentity', 'a2conc-tenant'];

  beforeAll(async () => {
    for (let i = 0; i < WRITERS; i++) {
      const e = new PostgresEngine();
      await e.connect({ database_url: DATABASE_URL! });
      engines.push(e);
    }
    await engines[0].initSchema();
    for (const id of SOURCES) {
      await engines[0].executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [id],
      );
      await engines[0].executeRaw(`DELETE FROM facts WHERE source_id = $1`, [id]);
    }
  }, 60_000);

  afterAll(async () => {
    for (const e of engines) await e.disconnect();
  }, 30_000);

  function ok(res: SaveFactsResult): Exclude<SaveFactsResult, { error: string }> {
    if ('error' in res) throw new Error(`unexpected validation error: ${res.detail}`);
    return res;
  }

  async function activeCount(src: string, text: string): Promise<number> {
    const rows = await engines[0].executeRaw<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL`,
      [src, text],
    );
    return Number(rows[0].n);
  }

  function tallies(results: Array<Exclude<SaveFactsResult, { error: string }>>) {
    const inserted = results.reduce((n, r) => n + r.inserted, 0);
    const duplicate = results.reduce((n, r) => n + r.duplicate, 0);
    return { inserted, duplicate };
  }

  test('entity-keyed claims: N concurrent verbatim saves land exactly one active row', async () => {
    const SRC = 'a2conc-entity';
    const TEXT = 'Concurrency pin: Marisol chairs the pricing committee';
    const results = await Promise.all(
      engines.map((e) =>
        runSaveFacts(
          [{ claim: TEXT, provenance: 'user_stated', people: ['Marisol'] }],
          { engine: e, sourceId: SRC },
        ).then(ok),
      ),
    );
    expect(await activeCount(SRC, TEXT)).toBe(1);
    const t = tallies(results);
    expect(t.inserted).toBe(1);
    expect(t.duplicate).toBe(WRITERS - 1);
  });

  test('entity-less claims: N concurrent verbatim saves land exactly one active row (folded-text lock key)', async () => {
    const SRC = 'a2conc-noentity';
    const TEXT = 'Concurrency pin: the renovation budget is forty thousand';
    const results = await Promise.all(
      engines.map((e) =>
        runSaveFacts([{ claim: TEXT, provenance: 'user_stated' }], { engine: e, sourceId: SRC }).then(ok),
      ),
    );
    expect(await activeCount(SRC, TEXT)).toBe(1);
    const t = tallies(results);
    expect(t.inserted).toBe(1);
    expect(t.duplicate).toBe(WRITERS - 1);
  });

  test('tenant-plane shape: concurrent withSourceScope dispatches serialize on the dedup window', async () => {
    const SRC = 'a2conc-tenant';
    const TEXT = 'Concurrency pin: the Lisbon lease renews every autumn';
    const results = await Promise.all(
      engines.map((e) =>
        e.withSourceScope(SRC, (scoped) =>
          runSaveFacts([{ claim: TEXT, provenance: 'user_stated', people: ['Rui'] }], {
            engine: scoped as unknown as PostgresEngine,
            sourceId: SRC,
          }),
        ).then((r) => ok(r as SaveFactsResult)),
      ),
    );
    expect(await activeCount(SRC, TEXT)).toBe(1);
    const t = tallies(results);
    expect(t.inserted).toBe(1);
    expect(t.duplicate).toBe(WRITERS - 1);
  });
});
