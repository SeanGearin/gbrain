/**
 * A2 fix-passes (2026-07-18) — N1 tombstone residual hardening. The three
 * residuals filed at the N1 verify (V-N1-2/3/4), red-first, one commit per
 * defect so each fix is bisectable.
 *
 * V-N1-2 — the escape hatch was ANY-`supersedes`, not head-checked. The
 *   tool doc already promised "carry supersedes:<live head id>" but the
 *   impl skipped the tombstone check for EVERY supersedes-carrying claim,
 *   so replaying a STALE CORRECTION batch (its supersedes names a
 *   mid-chain id, not the head) after a further correction re-minted the
 *   middle claim as live truth beside the real head. Post-fix the check
 *   runs on every active-miss and only a claim naming the chain's LIVE
 *   HEAD passes through; everything else gets the honest
 *   duplicate_superseded refusal pointing at that head.
 *
 * V-N1-3 — the chain walk was depth-bounded (32) with fall-OPEN: a legal
 *   chain deeper than 32 hops made the walk stop on an expired row,
 *   head_active came back false, and the replay minted a resurrection.
 *   Post-fix the walk carries a visited-path cycle guard instead of a
 *   depth bound: legal chains of any depth reach their head; a corrupted
 *   cyclic chain terminates and falls to the dead-chain policy (mint) —
 *   pinned as a control.
 *
 * V-N1-4 — the exact-text tombstone probe folded the PARAM in JS
 *   (toLowerCase) while comparing against the STORED text folded in SQL
 *   (lower()). The two fold tables disagree (verified on this PGLite:
 *   Greek word-final sigma 'ΚΌΣΤΟΣ' → js 'κόστος' vs pg 'κόστοσ'; Turkish
 *   'İstanbul' → js 'i̇stanbul' vs pg 'istanbul'), so a VERBATIM replay of
 *   a corrected-away claim containing such characters missed its
 *   tombstone and minted. Post-fix both sides are folded by the SAME
 *   engine (the param folds in SQL), so verbatim replay matches by
 *   construction on every locale/build.
 *
 * Harness: PGLite (matches facts-tombstone-dedup.test.ts). Real-PG twins
 * for the three cases live in test/e2e/facts-tombstone-dedup-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../src/core/facts/save.ts';

let engine: PGLiteEngine;

const TEST_SOURCES = [
  'tenant-h-replay', 'tenant-h-hatch', 'tenant-h-dead', 'tenant-h-novel',
  'tenant-h-deep', 'tenant-h-cycle', 'tenant-h-fold', 'tenant-h-fold2',
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of TEST_SOURCES) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

function ok(res: SaveFactsResult): Exclude<SaveFactsResult, { error: string }> {
  if ('error' in res) throw new Error(`unexpected validation error: ${res.detail}`);
  return res;
}

async function save(sourceId: string, claims: unknown[]) {
  return ok(await runSaveFacts(claims, { engine, sourceId }));
}

async function activeCount(sourceId: string, fact: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM facts
     WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL`,
    [sourceId, fact],
  );
  return Number(rows[0].n);
}

async function totalCount(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`,
    [sourceId],
  );
  return Number(rows[0].n);
}

// Lexically distant per-hop texts (trgm < 0.85 between any pair) — a
// near-dup hop would collapse into the head at Layer 1 and never build
// the chain (the receipted fixture trap).
const TA = 'Alexis runs the Tuesday vendor sync';
const TB = 'Priya inherited procurement coordination duties this spring';
const TC = 'The operations guild absorbed all supplier relationships in June';

/** Build the A→B→C correction chain through the real save path. */
async function buildChain(src: string): Promise<{ a: number; b: number; c: number }> {
  const va = await save(src, [{ claim: TA, provenance: 'user_stated' }]);
  const a = va.fact_ids[0];
  const vb = await save(src, [{ claim: TB, provenance: 'user_stated', supersedes: a }]);
  expect(vb.superseded).toBe(1);
  const b = vb.fact_ids[0];
  const vc = await save(src, [{ claim: TC, provenance: 'user_stated', supersedes: b }]);
  expect(vc.superseded).toBe(1);
  const c = vc.fact_ids[0];
  return { a, b, c };
}

// ───────────────────────────────────────────────────────────────────────────
// V-N1-2 — head-checked escape hatch
// ───────────────────────────────────────────────────────────────────────────

describe('tombstone hardening — V-N1-2 stale-correction replay', () => {
  test('RED: replaying a STALE correction batch (supersedes a mid-chain id) must not re-mint the middle claim', async () => {
    const SRC = 'tenant-h-replay';
    const { a, b, c } = await buildChain(SRC);
    const rowsBefore = await totalCount(SRC);

    // The stale correction batch, byte-replayed: TB corrects A. A further
    // correction (C) has since landed on top of B.
    const replay = await save(SRC, [
      { claim: TB, provenance: 'user_stated', supersedes: a },
    ]);

    // Honest refusal pointing at the live head — no resurrection of TB.
    expect(replay.inserted).toBe(0);
    expect(replay.duplicate).toBe(1);
    expect(replay.superseded).toBe(0);
    expect(replay.results[0]).toMatchObject({
      index: 0,
      status: 'duplicate_superseded',
      fact_id: c,
      superseded_from: b,
    });
    expect(await totalCount(SRC)).toBe(rowsBefore);
    expect(await activeCount(SRC, TB)).toBe(0);
    expect(await activeCount(SRC, TC)).toBe(1);
  });

  test('CONTROL: re-assertion naming the LIVE HEAD still re-mints with the chain intact', async () => {
    const SRC = 'tenant-h-hatch';
    const { c } = await buildChain(SRC);

    const reassert = await save(SRC, [
      { claim: TB, provenance: 'user_stated', supersedes: c },
    ]);
    expect(reassert.inserted).toBe(1);
    expect(reassert.superseded).toBe(1);
    expect(await activeCount(SRC, TB)).toBe(1);
    expect(await activeCount(SRC, TC)).toBe(0);
    const head = await engine.executeRaw<{ superseded_by: number | string | null }>(
      `SELECT superseded_by FROM facts WHERE id = $1`, [c],
    );
    expect(Number(head[0].superseded_by)).toBe(reassert.fact_ids[0]);
  });

  test('CONTROL: dead chain (head forgotten) + stale supersedes still mints — forget stays reversible', async () => {
    const SRC = 'tenant-h-dead';
    const { a, c } = await buildChain(SRC);
    // Forget/decay shape: plain expire, superseded_by stays NULL.
    expect(await engine.expireFact(c, { sourceId: SRC })).toBe(true);

    const replay = await save(SRC, [
      { claim: TB, provenance: 'user_stated', supersedes: a },
    ]);
    expect(replay.inserted).toBe(1);
    expect(await activeCount(SRC, TB)).toBe(1);
  });

  test('CONTROL: novel text carrying supersedes is untouched by the tombstone lane', async () => {
    const SRC = 'tenant-h-novel';
    const { c } = await buildChain(SRC);

    const novel = await save(SRC, [
      { claim: 'Quarterly supplier scorecards start in Q4', provenance: 'user_stated', supersedes: c },
    ]);
    expect(novel.inserted).toBe(1);
    expect(novel.superseded).toBe(1);
    expect(novel.results[0].status).toBe('inserted');
  });
});
