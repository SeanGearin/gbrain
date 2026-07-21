/**
 * save_facts valid_from — imported facts carry the SOURCE date, not today
 * (PACKET ENGINE-PREP 2026-07-20, FIX 2).
 *
 * The live defect this pins: on the customer plane the customer's own model
 * re-saves an imported conversation via save_facts, but ClaimSchema is .strict()
 * with NO valid_from field, so the historical date is dropped and both engines
 * stamp `valid_from = now()` (the import timestamp). "I imported my March chat"
 * then reads (and time-travels / trends / decays) as July. The concrete source
 * date IS available to the client (the tool asks it to resolve dates before
 * sending) — it just had no field to travel in.
 *
 * The fix (RED on 67ec1a1, GREEN after): add an optional per-claim `valid_from`
 * to ClaimSchema and thread it into NewFact.valid_from. Lenient parse: a garbage
 * or future date falls through to now() (fail-open — a malformed date must never
 * turn a capturable memory into a hard batch failure), while a genuine past
 * source date is honored. No migration — facts.valid_from already exists.
 *
 * PGLite, in-memory, no provider keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';

let engine: PGLiteEngine;
const SRC = 'tenant-validfrom';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    [SRC],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

async function validFromDate(factId: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ d: string | null }>(
    `SELECT to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM facts WHERE id = $1`,
    [factId],
  );
  return rows[0]?.d ?? null;
}

function todayUtc(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString().slice(0, 10);
}

describe('save_facts valid_from (import dates)', () => {
  test('an imported fact with a March source date reads back as March, not today', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Closed the Boltline deal at $4,000/month', provenance: 'user_stated', valid_from: '2026-03-15' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.inserted).toBe(1);
    expect(await validFromDate(res.fact_ids[0])).toBe('2026-03-15');
  });

  test('a fact WITHOUT valid_from still defaults to today (unchanged behavior)', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Signed the Northwind renewal today', provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(await validFromDate(res.fact_ids[0])).toBe(todayUtc());
  });

  test('a garbage valid_from fails OPEN — the fact still inserts, dated today (capture not weakened)', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Hired Priya as staff engineer', provenance: 'user_stated', valid_from: 'last Tuesday-ish' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.inserted).toBe(1);
    expect(await validFromDate(res.fact_ids[0])).toBe(todayUtc());
  });

  test('a zone-less ISO date-time is interpreted as UTC (no off-by-one-day on a non-UTC host)', async () => {
    // '2026-03-15T02:00:00' with no Z would parse as LOCAL; on a positive-UTC box
    // that crosses midnight backwards to 2026-03-14. Forcing UTC keeps the day.
    const res = await runSaveFacts(
      [{ claim: 'Kicked off the Aurora migration early morning', provenance: 'user_stated', valid_from: '2026-03-15T02:00:00' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(await validFromDate(res.fact_ids[0])).toBe('2026-03-15');
  });

  test('an explicit-offset ISO timestamp is honored (not double-shifted)', async () => {
    // 2026-03-15T23:30:00-05:00 == 2026-03-16T04:30:00Z → UTC day is the 16th.
    const res = await runSaveFacts(
      [{ claim: 'Closed the books late that night', provenance: 'user_stated', valid_from: '2026-03-15T23:30:00-05:00' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(await validFromDate(res.fact_ids[0])).toBe('2026-03-16');
  });

  test('a future valid_from is clamped to today (anti-poison: forward-dating skews decay/trajectory)', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Will renew Globex next cycle', provenance: 'user_stated', valid_from: '2031-01-01' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.inserted).toBe(1);
    expect(await validFromDate(res.fact_ids[0])).toBe(todayUtc());
  });
});
