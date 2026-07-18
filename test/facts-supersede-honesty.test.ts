/**
 * A2 fix-passes (engine adversarial pass 2026-07-18) — supersede honesty +
 * confinement on the B2 `supersedes` surface. Red-first; sections land one
 * commit per defect so each fix is bisectable.
 *
 * FS-4 — cross-source supersede confinement.
 *   `supersedes` is a raw client-supplied fact id. On any plane where RLS
 *   does not filter rows (the operator/incumbent BYPASSRLS relay — exactly
 *   the shape PGLite reproduces: no policies at all), the B2 paths would
 *   expire ANOTHER SOURCE's fact:
 *     - insert path: the atomic insert+expire UPDATE had no source_id
 *       predicate, so a foreign target was expired + chain-linked.
 *     - dedup path / fence follow-up: `supersedeFactDurably` SELECTed the
 *       target with no source predicate, then — for fence-backed foreign
 *       targets — STRUCK THE FOREIGN SOURCE'S FENCE FILE ON DISK.
 *   Post-fix: every supersede surface is confined to the caller's source;
 *   a foreign target is a silent not_found no-op (indistinguishable from a
 *   nonexistent id, matching the B2 contract), on every plane.
 *
 * FS-3 — the atomic insert+expire path counted DISPATCHES, not applied
 *   rows: `insertFact({supersedeId})` returned status 'superseded'
 *   unconditionally, so a nonexistent / already-expired / (pre-FS-4)
 *   foreign target still receipted `superseded: 1`. Post-fix the UPDATE's
 *   row count decides the status: 0 rows → 'inserted' (the new fact is
 *   real; the supersession did not happen and is not counted, and the
 *   fence follow-up is skipped).
 *
 * FS-5 — a future-id supersede could land on the row the INSERT itself
 *   just minted (serial hands out supersedeId): the new fact was born
 *   expired, superseded_by = itself, while the receipt said inserted+
 *   superseded. Post-fix the atomic UPDATE excludes the new row's own id;
 *   with FS-3's honest status the claim lands as a plain active insert.
 *
 * Controls pin the legitimate paths unchanged: same-source supersede still
 * applies on both B2 paths (incl. the fence strike), receipts and counters
 * keep their shapes, and the no-op disclosure stays absent for silent
 * cross-source refusals.
 *
 * PGLite harness (no RLS = the BYPASSRLS plane shape, where confinement
 * must come from the app layer). Real-PG twins for the confinement cases
 * live in test/e2e/facts-supersede-honesty-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../src/core/facts/save.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

// facts.source_id has an FK to sources(id); seed every tenant id the tests use.
// 'default' plays the FOREIGN fence-backed source (runExtractFacts reconciles
// the default source), the a2 tenants play the callers.
const TEST_SOURCES = [
  'tenant-a2-x', 'tenant-a2-y', 'tenant-a2-ctl',
  'tenant-a2-ghost', 'tenant-a2-expired', 'tenant-a2-double',
  'tenant-a2-self', 'tenant-a2-dedup-y',
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
  brainDir = mkdtempSync(join(tmpdir(), 'a2-supersede-'));
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

async function factState(id: number): Promise<{
  active: boolean; superseded_by: number | null; source_id: string;
}> {
  const rows = await engine.executeRaw<{
    expired_at: unknown; superseded_by: number | string | null; source_id: string;
  }>(
    `SELECT expired_at, superseded_by, source_id FROM facts WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw new Error(`fact ${id} not found`);
  return {
    active: rows[0].expired_at === null,
    superseded_by: rows[0].superseded_by == null ? null : Number(rows[0].superseded_by),
    source_id: rows[0].source_id,
  };
}

/** Seed a fence-backed fact in the DEFAULT source (disk + DB via reconcile). */
async function seedDefaultFenceFact(slug: string, claim: string): Promise<number> {
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
  const body = `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | high | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->
`;
  writeFileSync(join(brainDir, `${slug}.md`), body, 'utf-8');
  await engine.putPage(slug, {
    title: slug, type: 'person', compiled_truth: body, frontmatter: {}, timeline: '',
  });
  const r = await runExtractFacts(engine, { slugs: [slug] });
  expect(r.factsInserted).toBe(1);
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT id FROM facts WHERE source_markdown_slug = $1`, [slug],
  );
  return Number(rows[0].id);
}

// ───────────────────────────────────────────────────────────────────────────
// FS-4 — cross-source supersede confinement
// ───────────────────────────────────────────────────────────────────────────

describe('save_facts — FS-4 cross-source supersede confinement (BYPASSRLS plane shape)', () => {
  test('RED insert path: supersedes pointing at another source\'s fact must NOT expire it', async () => {
    const vx = await save('tenant-a2-x', [
      { claim: 'Priya owns the vendor relationship', provenance: 'user_stated', people: ['Priya'] },
    ]);
    const foreignId = vx.fact_ids[0];

    // Novel text in Y carrying a supersedes id that belongs to X.
    const vy = await save('tenant-a2-y', [
      { claim: 'The quarterly budget review moved to Thursdays', provenance: 'user_stated', supersedes: foreignId },
    ]);

    // The foreign fact is untouched — a cross-source target is a silent no-op.
    const foreign = await factState(foreignId);
    expect(foreign.active).toBe(true);
    expect(foreign.superseded_by).toBeNull();

    // The new claim itself is a real insert. (The `superseded` counter on
    // this path is dispatch-counted until FS-3's commit makes the atomic
    // path row-count-honest — its asserts live in the FS-3 section below.)
    expect(vy.inserted).toBe(1);

    // Y's own fact is a real active insert.
    const mine = await factState(vy.fact_ids[0]);
    expect(mine.active).toBe(true);
    expect(mine.source_id).toBe('tenant-a2-y');
  });

  test('RED dedup path: duplicate+supersedes across sources must NOT expire the foreign target', async () => {
    const vx = await save('tenant-a2-x', [
      { claim: 'Halden Labs renews in March', provenance: 'user_stated', entities: ['Halden Labs'] },
    ]);
    const foreignId = vx.fact_ids[0];

    // Y saves its own claim, then replays it as a "correction" of X's fact:
    // dedup hits Y's canonical row, and the supersede must be confined to Y.
    await save('tenant-a2-dedup-y', [
      { claim: 'Standing sync is every second Monday', provenance: 'user_stated' },
    ]);
    const replay = await save('tenant-a2-dedup-y', [
      { claim: 'Standing sync is every second Monday', provenance: 'user_stated', supersedes: foreignId },
    ]);

    expect(replay.duplicate).toBe(1);
    expect(replay.superseded).toBe(0);

    const foreign = await factState(foreignId);
    expect(foreign.active).toBe(true);
    expect(foreign.superseded_by).toBeNull();

    // Silent no-op: no durability disclosure leaks the target's existence.
    expect(replay.results[0]).not.toHaveProperty('supersede_durable');
    expect(replay.results[0]).not.toHaveProperty('supersede_reason');
  });

  test('RED fence follow-up: a foreign fence-backed target\'s FILE must not be struck', async () => {
    const foreignId = await seedDefaultFenceFact('people/marisol', 'Marisol leads the audit team');
    const filePath = join(brainDir, 'people/marisol.md');
    const bytesBefore = readFileSync(filePath, 'utf-8');

    // Tenant Y "corrects" the default source's fence-backed fact.
    const vy = await save('tenant-a2-y', [
      { claim: 'The audit workstream reports directly to the board now', provenance: 'user_stated', supersedes: foreignId },
    ]);

    // DB row untouched…
    const foreign = await factState(foreignId);
    expect(foreign.active).toBe(true);
    expect(foreign.superseded_by).toBeNull();
    // …and the foreign source's fence file is byte-identical (no strike, no marker).
    const bytesAfter = readFileSync(filePath, 'utf-8');
    expect(bytesAfter).toBe(bytesBefore);
    expect(bytesAfter).not.toContain('~~');
    expect(bytesAfter).not.toContain('superseded by fact #');

    expect(vy.inserted).toBe(1);
  });

  test('FS-3 RED: nonexistent supersede target must not count — superseded: 0, status inserted', async () => {
    const res = await save('tenant-a2-ghost', [
      { claim: 'The retro moved to the first Friday of the month', provenance: 'user_stated', supersedes: 99999999 },
    ]);
    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(0);
    expect(res.results[0].status).toBe('inserted');
    const mine = await factState(res.fact_ids[0]);
    expect(mine.active).toBe(true);
  });

  test('FS-3 RED: already-expired target — a second correction batch must not double-count', async () => {
    const SRC = 'tenant-a2-expired';
    const first = await save(SRC, [
      { claim: 'Dario is the launch DRI', provenance: 'user_stated', people: ['Dario'] },
    ]);
    const targetId = first.fact_ids[0];

    // Correction 1 genuinely applies.
    const corr1 = await save(SRC, [
      { claim: 'Noor took over as launch DRI in June', provenance: 'user_stated', people: ['Noor'], supersedes: targetId },
    ]);
    expect(corr1.superseded).toBe(1);

    // Correction 2 targets the SAME (now expired) row with novel text:
    // zero rows change, so zero supersessions are counted.
    const corr2 = await save(SRC, [
      { claim: 'The launch DRI rotation is documented in the runbook', provenance: 'user_stated', supersedes: targetId },
    ]);
    expect(corr2.inserted).toBe(1);
    expect(corr2.superseded).toBe(0);
    expect(corr2.results[0].status).toBe('inserted');

    // The chain still points at correction 1 — correction 2 didn't clobber it.
    const target = await factState(targetId);
    expect(target.superseded_by).toBe(corr1.fact_ids[0]);
  });

  test('FS-3 RED: cross-source insert-path receipt is honest post-confinement — superseded: 0, status inserted', async () => {
    const vx = await save('tenant-a2-x', [
      { claim: 'Ravi holds the second on-call slot', provenance: 'user_stated', people: ['Ravi'] },
    ]);
    const foreignId = vx.fact_ids[0];

    const vy = await save('tenant-a2-y', [
      { claim: 'On-call handoff happens at 09:00 UTC', provenance: 'user_stated', supersedes: foreignId },
    ]);
    // FS-4 confined the write; FS-3 makes the receipt match: no row changed,
    // so nothing is counted and the status says plain insert.
    expect(vy.superseded).toBe(0);
    expect(vy.results[0].status).toBe('inserted');
    expect((await factState(foreignId)).active).toBe(true);
  });

  test('FS-3 CONTROL: a supersede that applies still counts exactly once, and the fence follow-up still fires', async () => {
    const fenceId = await seedDefaultFenceFact('people/imogen', 'Imogen owns the data-room checklist');
    const corr = await save('default', [
      { claim: 'The data-room checklist moved to Priya after the reorg', provenance: 'user_stated', supersedes: fenceId },
    ]);
    expect(corr.inserted).toBe(1);
    expect(corr.superseded).toBe(1);
    expect(corr.results[0].status).toBe('inserted');
    // Follow-up ran: fence struck durably (no disclosure fields present).
    expect(corr.results[0]).not.toHaveProperty('supersede_durable');
    const fenceBody = readFileSync(join(brainDir, 'people/imogen.md'), 'utf-8');
    expect(fenceBody).toContain('~~Imogen owns the data-room checklist~~');
    const target = await factState(fenceId);
    expect(target.active).toBe(false);
    expect(target.superseded_by).toBe(corr.fact_ids[0]);
  });

  test('CONTROL: same-source supersede still applies on both B2 paths (incl. the fence strike)', async () => {
    // Insert path, plain rows.
    const first = await save('tenant-a2-ctl', [
      { claim: 'Ilya works out of the Lisbon office', provenance: 'user_stated', people: ['Ilya'] },
    ]);
    const targetId = first.fact_ids[0];
    const corr = await save('tenant-a2-ctl', [
      { claim: 'Ilya relocated to the Warsaw office', provenance: 'user_stated', people: ['Ilya'], supersedes: targetId },
    ]);
    expect(corr.superseded).toBe(1);
    expect(corr.results[0].status).toBe('inserted');
    const target = await factState(targetId);
    expect(target.active).toBe(false);
    expect(target.superseded_by).toBe(corr.fact_ids[0]);

    // Fence strike, same source (default): the durable path still works.
    const fenceId = await seedDefaultFenceFact('people/tomas', 'Tomas is on the night rotation');
    const fenceCorr = await save('default', [
      { claim: 'Tomas moved to the day rotation in July', provenance: 'user_stated', supersedes: fenceId },
    ]);
    expect(fenceCorr.superseded).toBe(1);
    const fenceBody = readFileSync(join(brainDir, 'people/tomas.md'), 'utf-8');
    expect(fenceBody).toContain('~~Tomas is on the night rotation~~');
    expect(fenceBody).toContain(`superseded by fact #${fenceCorr.fact_ids[0]}`);
  });
});
