/**
 * N1 tombstone dedup — real-Postgres twin of the four decision-memo gate
 * cases (cc-findings_2026-07-17_engine-audit-n1-decision.md, Option A).
 *
 * The pglite half lives in test/facts-tombstone-dedup.test.ts (runs
 * everywhere, keyless). This file proves the postgres-engine
 * findSupersededTombstone impl (recursive-CTE tombstone lookup + bounded
 * superseded_by walk) and the save.ts wiring against a real Postgres:
 *   1. replay-after-supersede → duplicate_superseded, no new row;
 *   2. same claim + supersedes:<live head> re-mints atomically (escape hatch);
 *   3. forget-then-resave still mints (superseded_by NULL never matches);
 *   4. same-batch insert → correct → replay resolves duplicate_superseded
 *      (same-tx read visibility).
 *
 * Skips gracefully when DATABASE_URL is unset.
 *
 * Run: DATABASE_URL=postgresql://... bun test test/e2e/facts-tombstone-dedup-postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../../src/core/facts/save.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  test.skip('facts-tombstone-dedup postgres twin skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('N1 tombstone dedup against real Postgres', () => {
  let pg: PostgresEngine;

  const SOURCES = ['n1pg-core', 'n1pg-hatch', 'n1pg-forget', 'n1pg-batch'];

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

  async function totalCount(sourceId: string): Promise<number> {
    const rows = await pg.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`,
      [sourceId],
    );
    return Number(rows[0].n);
  }

  test('gate 1: byte-replay after an interleaved supersede returns duplicate_superseded at the live head — no new row', async () => {
    const SRC = 'n1pg-core';
    const ORIGINAL = 'The invoice is due on the first of the month';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const originalId = first.fact_ids[0];
    const corr = await save(SRC, [
      { claim: 'Payment terms changed to net-45 going forward', provenance: 'user_stated', supersedes: originalId },
    ]);
    expect(corr.superseded).toBe(1);
    const headId = corr.fact_ids[0];

    const before = await totalCount(SRC);
    const replay = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    expect(replay.inserted).toBe(0);
    expect(replay.results[0]).toMatchObject({
      index: 0,
      status: 'duplicate_superseded',
      fact_id: headId,
      superseded_from: originalId,
    });
    expect(await totalCount(SRC)).toBe(before);
  });

  test('gate 2 (escape hatch): the same claim carrying supersedes:<head> re-mints atomically with the chain intact', async () => {
    const SRC = 'n1pg-hatch';
    const ORIGINAL = 'The retreat is booked for Lake Tahoe';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const corr = await save(SRC, [
      { claim: 'Offsite location switched to Palm Springs', provenance: 'user_stated', supersedes: first.fact_ids[0] },
    ]);
    const headId = corr.fact_ids[0];

    const reassert = await save(SRC, [
      { claim: ORIGINAL, provenance: 'user_stated', supersedes: headId },
    ]);
    expect(reassert.inserted).toBe(1);
    expect(reassert.superseded).toBe(1);
    const remintId = reassert.fact_ids[0];

    const head = await pg.executeRaw<{ expired_at: unknown; superseded_by: number | string | null }>(
      `SELECT expired_at, superseded_by FROM facts WHERE id = $1`,
      [headId],
    );
    expect(head[0].expired_at).not.toBeNull();
    expect(Number(head[0].superseded_by)).toBe(remintId);
  });

  test('gate 3: forget-then-resave still mints (forget tombstones never match)', async () => {
    const SRC = 'n1pg-forget';
    const CLAIM = 'The support rotation includes weekends';

    const first = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated' }]);
    const forgot = await forgetFactInFence(pg, first.fact_ids[0]);
    expect(forgot.ok).toBe(true);

    const resave = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated' }]);
    expect(resave.inserted).toBe(1);
    expect(resave.results[0]).toMatchObject({ index: 0, status: 'inserted' });
  });

  test('gate 4: same-batch insert → correct → replay resolves duplicate_superseded (same-tx visibility)', async () => {
    const SRC = 'n1pg-batch';
    const ORIGINAL = 'Demo day lands on the last Thursday';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const originalId = first.fact_ids[0];

    const batch = await save(SRC, [
      { claim: 'Showcase rescheduled to the second Monday', provenance: 'user_stated', supersedes: originalId },
      { claim: ORIGINAL, provenance: 'user_stated' },
    ]);
    const headId = batch.fact_ids[0];
    expect(batch.results[0]).toMatchObject({ index: 0, status: 'inserted', fact_id: headId });
    expect(batch.results[1]).toMatchObject({
      index: 1,
      status: 'duplicate_superseded',
      fact_id: headId,
      superseded_from: originalId,
    });
  });
});
