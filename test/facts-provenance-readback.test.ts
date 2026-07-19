/**
 * B8 provenance READBACK regression (PACKET P2 2026-07-19 — fact 8943).
 *
 * The live defect this pins: a plainly user-stated fact saved through the
 * normal path (worker save_facts → engine save_facts) read back with
 * `[origin unknown]`. Root cause chain, located 2026-07-19:
 *   - the stamp IS written: save.ts requires provenance at intake and stamps
 *     provenance + client_authored per row (facts-save.test.ts pins this via
 *     raw SQL);
 *   - the deployed engine (b0b681ee) DROPS it on the way out: FactRow /
 *     rowToFact* / the recall response serialization all omit the column, so
 *     every retrieval degrades to "no client provenance recorded" and the
 *     worker honestly renders [origin unknown];
 *   - the B8 projection (this candidate lineage) restores it — but until this
 *     file, NO test asserted the READBACK: stamping was pinned, projection was
 *     not, which is exactly the gap the defect shipped through.
 *
 * So this test drives the full retrieval path a remote client hits
 * (dispatchToolCall → recall op → response serialization) and asserts a
 * user-stated save reads back user-stated. Two assert layers per case so a
 * future failure localizes itself: the raw-SQL stamp assert (write side) vs
 * the response assert (projection side) — the packet's "not written vs not
 * returned vs not rendered" split, answerable from the failure line alone.
 *
 * RED-FIRST proof (2026-07-19): this exact file FAILS at the deployed sha
 * b0b681ee (response rows carry no provenance key) and PASSES on the
 * candidate lineage (3238bcc) — both runs captured in
 * virgil-sean/sessions/cc-findings_2026-07-19_canary-and-provenance.md.
 *
 * Runs on PGLite (in-memory, no DSN) like its siblings; the real-PG twin
 * concern is projection code shared verbatim via rowToFactPg, and the
 * postgres SELECT * path is exercised by the e2e facts suites.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const SOURCE = 'tenant-provenance-rt';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    [SOURCE],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

// The owner-scoped remote caller shape (mirrors serve-http: ctx.sourceId is
// the query scope, ctx.auth.sourceId the owner signal — same as the R-3
// owner-visibility test, so private save_facts rows read back).
function ownerCaller() {
  return {
    remote: true,
    sourceId: SOURCE,
    auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId: SOURCE },
  };
}

async function stampOf(id: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ provenance: string | null }>(
    `SELECT provenance FROM facts WHERE id = $1`,
    [id],
  );
  return rows[0] ? rows[0].provenance : null;
}

async function recallRows(): Promise<Array<Record<string, unknown>>> {
  const r = await dispatchToolCall(engine, 'recall', {}, ownerCaller());
  const payload = JSON.parse(r.content[0].text);
  return payload.facts as Array<Record<string, unknown>>;
}

describe('provenance readback — a user-stated save reads back user-stated (B8 / fact 8943)', () => {
  test('user_stated round-trips through the recall response', async () => {
    const saved = await runSaveFacts(
      [{ claim: 'The pricing floor is $12,000 per client', provenance: 'user_stated', kind: 'fact' }],
      { engine, sourceId: SOURCE },
    );
    if ('error' in saved) throw new Error(`save_facts rejected: ${JSON.stringify(saved)}`);
    expect(saved.inserted).toBe(1);
    const id = saved.fact_ids[0];

    // Write side (the stamp): if THIS fails, provenance is not being written.
    expect(await stampOf(id)).toBe('user_stated');

    // Read side (the projection — where fact 8943 fell through): if THIS
    // fails while the stamp assert above passed, retrieval is dropping it.
    const row = recallRowById(await recallRows(), id);
    expect(row).toBeDefined();
    expect(row!.provenance).toBe('user_stated');
  });

  test('model_inferred round-trips through the recall response', async () => {
    const saved = await runSaveFacts(
      [{ claim: 'The client probably prefers quarterly billing', provenance: 'model_inferred' }],
      { engine, sourceId: SOURCE },
    );
    if ('error' in saved) throw new Error(`save_facts rejected: ${JSON.stringify(saved)}`);
    const id = saved.fact_ids[0];
    expect(await stampOf(id)).toBe('model_inferred');
    const row = recallRowById(await recallRows(), id);
    expect(row).toBeDefined();
    expect(row!.provenance).toBe('model_inferred');
  });

  test('the response never invents provenance: the key is present-and-null only when the row truly has none', async () => {
    // Every row in this suite was saved via save_facts, so every projected
    // provenance must be one of the two client labels — a third value or a
    // fabricated default would break the closed-vocabulary contract the
    // worker renders from ([you said] / [inferred] / [origin unknown]).
    for (const row of await recallRows()) {
      expect(['user_stated', 'model_inferred']).toContain(row.provenance as string);
    }
  });
});

function recallRowById(rows: Array<Record<string, unknown>>, id: number): Record<string, unknown> | undefined {
  return rows.find((r) => r.id === id);
}
