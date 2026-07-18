/**
 * A2 fix-passes (2026-07-18) — real-Postgres twins for the six A2 fixes
 * (FS-4 / FS-3 / FS-5 supersede honesty+confinement; V-N1-2/3/4 tombstone
 * hardening). The PGLite halves live in test/facts-supersede-honesty.test.ts
 * and test/facts-tombstone-hardening.test.ts; this file proves the
 * postgres-engine twins (atomic insert+expire UPDATE predicates, the
 * cycle-guard recursive CTE, the SQL-side fold) on the deploy engine class.
 *
 * Worth stating: the V-N1-4 Greek case diverges on real UTF-8 Postgres
 * too — PG lower() never emits the context-sensitive final sigma JS
 * produces — so that red was live on the box's engine class, not a
 * PGLite locale artifact.
 *
 * Skips gracefully when DATABASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../../src/core/facts/save.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  test.skip('facts-a2-hardening postgres twin skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('A2 supersede honesty + tombstone hardening against real Postgres', () => {
  let pg: PostgresEngine;

  const SOURCES = [
    'a2pg-x', 'a2pg-y', 'a2pg-ghost', 'a2pg-self',
    'a2pg-replay', 'a2pg-deep', 'a2pg-fold',
  ];

  beforeAll(async () => {
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    await pg.initSchema();
    for (const id of SOURCES) {
      await pg.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [id],
      );
      await pg.executeRaw(`DELETE FROM facts WHERE source_id = $1`, [id]);
    }
  }, 60_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  }, 30_000);

  function ok(res: SaveFactsResult): Exclude<SaveFactsResult, { error: string }> {
    if ('error' in res) throw new Error(`unexpected validation error: ${res.detail}`);
    return res;
  }

  async function save(sourceId: string, claims: unknown[]) {
    return ok(await runSaveFacts(claims, { engine: pg, sourceId }));
  }

  async function factState(id: number): Promise<{ active: boolean; superseded_by: number | null }> {
    const rows = await pg.executeRaw<{ expired_at: unknown; superseded_by: number | string | null }>(
      `SELECT expired_at, superseded_by FROM facts WHERE id = $1`, [id],
    );
    if (rows.length === 0) throw new Error(`fact ${id} not found`);
    return {
      active: rows[0].expired_at === null,
      superseded_by: rows[0].superseded_by == null ? null : Number(rows[0].superseded_by),
    };
  }

  async function activeCount(sourceId: string, fact: string): Promise<number> {
    const rows = await pg.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL`,
      [sourceId, fact],
    );
    return Number(rows[0].n);
  }

  test('FS-4: cross-source supersede is a silent no-op on the privileged (BYPASSRLS-shape) connection', async () => {
    const vx = await save('a2pg-x', [
      { claim: 'Priya owns the vendor relationship', provenance: 'user_stated', people: ['Priya'] },
    ]);
    const foreignId = vx.fact_ids[0];

    const vy = await save('a2pg-y', [
      { claim: 'The quarterly budget review moved to Thursdays', provenance: 'user_stated', supersedes: foreignId },
    ]);
    const foreign = await factState(foreignId);
    expect(foreign.active).toBe(true);
    expect(foreign.superseded_by).toBeNull();
    expect(vy.superseded).toBe(0);
    expect(vy.results[0].status).toBe('inserted');
  });

  test('FS-3: nonexistent target — superseded: 0, status inserted, row active', async () => {
    const res = await save('a2pg-ghost', [
      { claim: 'The retro moved to the first Friday of the month', provenance: 'user_stated', supersedes: 999999999 },
    ]);
    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(0);
    expect(res.results[0].status).toBe('inserted');
    expect((await factState(res.fact_ids[0])).active).toBe(true);
  });

  test('FS-5: future-id self-supersede lands as a plain active insert', async () => {
    const SRC = 'a2pg-self';
    const probe = await pg.insertFact(
      { fact: 'serial probe row for FS-5 on real PG', source: 'mcp:save_facts', client_authored: true },
      { source_id: SRC },
    );
    const predictedNextId = probe.id + 1;
    const res = await save(SRC, [
      { claim: 'The design review cadence doubled during launch month', provenance: 'user_stated', supersedes: predictedNextId },
    ]);
    expect(res.fact_ids[0]).toBe(predictedNextId);
    const mine = await factState(predictedNextId);
    expect(mine.active).toBe(true);
    expect(mine.superseded_by).toBeNull();
    expect(res.superseded).toBe(0);
  });

  test('V-N1-2: stale-correction replay refuses at the live head; head-naming re-assertion passes', async () => {
    const SRC = 'a2pg-replay';
    const TA = 'Alexis runs the Tuesday vendor sync';
    const TB = 'Priya inherited procurement coordination duties this spring';
    const TC = 'The operations guild absorbed all supplier relationships in June';
    const a = (await save(SRC, [{ claim: TA, provenance: 'user_stated' }])).fact_ids[0];
    const vb = await save(SRC, [{ claim: TB, provenance: 'user_stated', supersedes: a }]);
    const b = vb.fact_ids[0];
    const vc = await save(SRC, [{ claim: TC, provenance: 'user_stated', supersedes: b }]);
    const c = vc.fact_ids[0];

    const replay = await save(SRC, [{ claim: TB, provenance: 'user_stated', supersedes: a }]);
    expect(replay.inserted).toBe(0);
    expect(replay.results[0]).toMatchObject({ status: 'duplicate_superseded', fact_id: c, superseded_from: b });
    expect(await activeCount(SRC, TB)).toBe(0);

    const reassert = await save(SRC, [{ claim: TB, provenance: 'user_stated', supersedes: c }]);
    expect(reassert.inserted).toBe(1);
    expect(reassert.superseded).toBe(1);
    expect(await activeCount(SRC, TB)).toBe(1);
  });

  test('V-N1-3: a 40-hop chain with an ACTIVE head refuses the replay (cycle-guard walk)', async () => {
    const SRC = 'a2pg-deep';
    const hopText = (i: number) => `deep chain hop ${i} — filler ${i * 7919} orthogonal payload ${String.fromCharCode(65 + (i % 26))}`;
    const ids: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const rows = await pg.executeRaw<{ id: number | string }>(
        `INSERT INTO facts (source_id, fact, kind, visibility, notability, source, client_authored)
         VALUES ($1, $2, 'fact', 'private', 'medium', 'mcp:save_facts', true) RETURNING id`,
        [SRC, hopText(i)],
      );
      ids.push(Number(rows[0].id));
    }
    for (let i = 0; i < 40; i++) {
      await pg.executeRaw(
        `UPDATE facts SET expired_at = now(), superseded_by = $1 WHERE id = $2`,
        [ids[i + 1], ids[i]],
      );
    }

    const replay = await save(SRC, [{ claim: hopText(0), provenance: 'user_stated' }]);
    expect(replay.inserted).toBe(0);
    expect(replay.results[0]).toMatchObject({
      status: 'duplicate_superseded',
      fact_id: ids[40],
      superseded_from: ids[0],
    });
  });

  test('V-N1-4: verbatim Greek (word-final Σ) replay hits its tombstone on real UTF-8 Postgres', async () => {
    const SRC = 'a2pg-fold';
    const TGREEK = 'ΤΟ ΚΌΣΤΟΣ ΑΝΆΠΤΥΞΗΣ ΞΕΠΈΡΑΣΕ ΤΙΣ ΣΑΡΆΝΤΑ ΧΙΛΙΆΔΕΣ';
    const first = await save(SRC, [{ claim: TGREEK, provenance: 'user_stated' }]);
    const corr = await save(SRC, [
      { claim: 'The development budget was revised well below forty thousand', provenance: 'user_stated', supersedes: first.fact_ids[0] },
    ]);
    expect(corr.superseded).toBe(1);

    const replay = await save(SRC, [{ claim: TGREEK, provenance: 'user_stated' }]);
    expect(replay.inserted).toBe(0);
    expect(replay.results[0]).toMatchObject({
      status: 'duplicate_superseded',
      fact_id: corr.fact_ids[0],
      superseded_from: first.fact_ids[0],
    });
    expect(await activeCount(SRC, TGREEK)).toBe(0);
  });
});
