/**
 * N1 tombstone dedup + durable-supersede wiring (engine audit 2026-07-17,
 * decision memo cc-findings_2026-07-17_engine-audit-n1-decision.md, Option A).
 *
 * Two linked changes, red-first:
 *
 * (a) save.ts wires the v0.42.24 durable supersede (facts/supersede.ts) into
 *     BOTH B2 paths. Dedup path: `supersedeFactDurably` replaces the bare
 *     `expireFact`, so a fence-backed target is struck in the fence and the
 *     supersession survives a rebuild; non-durable outcomes are DISCLOSED on
 *     the per-claim receipt (`supersede_durable: false` + `supersede_reason`).
 *     Insert path: the atomic insert+expire stays; a fence follow-up call
 *     (`followUp: true`) strikes the fence after the tx.
 *
 * (b) N1 Option A: a THIRD dedup check, exact-text only, firing ONLY when
 *     active dedup misses, scoped to correction tombstones
 *     (`superseded_by IS NOT NULL`), returning `duplicate_superseded`
 *     pointing at the live head of the chain. The escape hatch is the
 *     EXISTING `supersedes` field: a claim that carries it skips the
 *     tombstone check and re-mints through the atomic path with the chain
 *     intact. Forget tombstones (`superseded_by` NULL) never block a
 *     re-save — deliberate deletion stays reversible.
 *
 * THE BUG (pre-fix): dedup consults ACTIVE rows only, so replaying the
 * ORIGINAL text after an interleaved correction re-mints the corrected-away
 * claim as live truth with a clean 'inserted' receipt and `superseded_by`
 * NULL — outside the audit chain, invisible to recall(supersessions:true).
 * The one retry pattern that crosses a supersede was silently poisonous
 * while every other retry is safe.
 *
 * Controls pinned green (pre- AND post-fix): plain retry still dedups;
 * correction-batch retry stays idempotent (counter AND fence bytes);
 * forget-then-resave still mints; a supersedes-carrying re-assertion
 * re-mints with the chain intact.
 *
 * Runs entirely on PGLite (keyless: Layer-1 dedup only), matching the
 * facts-save.test.ts harness; the fence half borrows the
 * facts-supersede.test.ts disk-fence harness. Postgres twins for the four
 * memo gate cases live in test/e2e/facts-tombstone-dedup-postgres.test.ts
 * (DATABASE_URL-gated).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts, type SaveFactsResult } from '../src/core/facts/save.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;

// facts.source_id has an FK to sources(id); seed every tenant id the tests use.
const TEST_SOURCES = [
  'tenant-n1-core', 'tenant-n1-retry', 'tenant-n1-corr-retry',
  'tenant-n1-forget', 'tenant-n1-hatch', 'tenant-n1-batch',
  'tenant-n1-walk', 'tenant-n1-dead', 'tenant-n1-norm',
  'tenant-n1-iso-x', 'tenant-n1-iso-y',
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

/** Narrow the union or fail loudly — every test expects the tally shape. */
function ok(res: SaveFactsResult): Exclude<SaveFactsResult, { error: string }> {
  if ('error' in res) throw new Error(`unexpected validation error: ${res.detail}`);
  return res;
}

async function save(sourceId: string, claims: unknown[]) {
  return ok(await runSaveFacts(claims, { engine, sourceId }));
}

/** Active rows carrying EXACTLY this fact text in a source. */
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

async function supersessionState(id: number): Promise<{
  expired_at: unknown; superseded_by: number | null;
}> {
  const rows = await engine.executeRaw<{ expired_at: unknown; superseded_by: number | string | null }>(
    `SELECT expired_at, superseded_by FROM facts WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return {
    expired_at: row.expired_at,
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (b) N1 Option A — the tombstone check
// ───────────────────────────────────────────────────────────────────────────

describe('save_facts — N1 replay-after-supersede (the resurrection class)', () => {
  test('CORE: byte-replay of corrected-away text returns duplicate_superseded pointing at the live head — no resurrection', async () => {
    const SRC = 'tenant-n1-core';
    const ORIGINAL = "Marta's hourly rate is $80";
    const CORRECTED = "Marta's hourly rate is $95";

    const first = await save(SRC, [
      { claim: ORIGINAL, provenance: 'user_stated', people: ['Marta'] },
    ]);
    const originalId = first.fact_ids[0];

    const corr = await save(SRC, [
      { claim: CORRECTED, provenance: 'user_stated', people: ['Marta'], supersedes: originalId },
    ]);
    expect(corr.superseded).toBe(1);
    const headId = corr.fact_ids[0];

    const rowsBefore = await totalCount(SRC);

    // The N1 window: an MCP retry / stale-export replay of the ORIGINAL bytes.
    const replay = await save(SRC, [
      { claim: ORIGINAL, provenance: 'user_stated', people: ['Marta'] },
    ]);

    // Honest receipt: this text was corrected away; live truth is the head.
    expect(replay.inserted).toBe(0);
    expect(replay.duplicate).toBe(1);
    expect(replay.superseded).toBe(0);
    expect(replay.fact_ids).toEqual([headId]);
    expect(replay.results[0]).toMatchObject({
      index: 0,
      status: 'duplicate_superseded',
      fact_id: headId,
      superseded_from: originalId,
    });

    // No new row, no active resurrection, chain untouched.
    expect(await totalCount(SRC)).toBe(rowsBefore);
    expect(await activeCount(SRC, ORIGINAL)).toBe(0);
    expect(await activeCount(SRC, CORRECTED)).toBe(1);
    const orig = await supersessionState(originalId);
    expect(orig.expired_at).not.toBeNull();
    expect(orig.superseded_by).toBe(headId);
  });

  test('CONTROL: plain retry with no interleaved correction still dedups as plain duplicate', async () => {
    const SRC = 'tenant-n1-retry';
    const CLAIM = 'Jonas prefers morning meetings';

    const first = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated', people: ['Jonas'] }]);
    const id = first.fact_ids[0];

    const retry = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated', people: ['Jonas'] }]);
    expect(retry.inserted).toBe(0);
    expect(retry.duplicate).toBe(1);
    expect(retry.results[0]).toMatchObject({ index: 0, status: 'duplicate', fact_id: id });
  });

  test('CONTROL: correction-batch retry stays idempotent (superseded not re-counted)', async () => {
    const SRC = 'tenant-n1-corr-retry';
    const OLD = 'Priya is on the Free plan';
    const NEW = 'Priya is on the Pro plan';

    const oldRes = await save(SRC, [{ claim: OLD, provenance: 'user_stated', people: ['Priya'] }]);
    const oldId = oldRes.fact_ids[0];
    const newRes = await save(SRC, [{ claim: NEW, provenance: 'user_stated', people: ['Priya'] }]);
    const newId = newRes.fact_ids[0];

    // First application of the correction (dedup path: text already canonical).
    const corr = await save(SRC, [
      { claim: NEW, provenance: 'user_stated', people: ['Priya'], supersedes: oldId },
    ]);
    expect(corr.superseded).toBe(1);
    expect(corr.duplicate).toBe(1);

    // The MCP retry of that same correction batch: target already expired →
    // honest no-op, counter stays 0, state unchanged.
    const retry = await save(SRC, [
      { claim: NEW, provenance: 'user_stated', people: ['Priya'], supersedes: oldId },
    ]);
    expect(retry.superseded).toBe(0);
    expect(retry.duplicate).toBe(1);
    expect(retry.inserted).toBe(0);
    const state = await supersessionState(oldId);
    expect(state.superseded_by).toBe(newId);
  });

  test('CONTROL: forget-then-resave still mints — deliberate deletion stays reversible', async () => {
    const SRC = 'tenant-n1-forget';
    const CLAIM = 'Ravi is allergic to shellfish';

    const first = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated', people: ['Ravi'] }]);
    const id = first.fact_ids[0];

    // The REAL forget path (save_facts rows are not fence-backed → legacy DB
    // expire, superseded_by stays NULL — the discriminator the tombstone
    // check scopes on).
    const forgot = await forgetFactInFence(engine, id);
    expect(forgot.ok).toBe(true);
    const state = await supersessionState(id);
    expect(state.expired_at).not.toBeNull();
    expect(state.superseded_by).toBeNull();

    const resave = await save(SRC, [{ claim: CLAIM, provenance: 'user_stated', people: ['Ravi'] }]);
    expect(resave.inserted).toBe(1);
    expect(resave.duplicate).toBe(0);
    expect(resave.results[0]).toMatchObject({ index: 0, status: 'inserted' });
    expect(resave.fact_ids[0]).not.toBe(id);
    expect(await activeCount(SRC, CLAIM)).toBe(1);
  });

  test('CONTROL (escape hatch): re-asserting corrected-away text WITH supersedes re-mints atomically, chain intact', async () => {
    const SRC = 'tenant-n1-hatch';
    const ORIGINAL = 'The launch is planned for March';
    const CORRECTED = 'The launch is planned for April';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const originalId = first.fact_ids[0];
    const corr = await save(SRC, [
      { claim: CORRECTED, provenance: 'user_stated', supersedes: originalId },
    ]);
    const headId = corr.fact_ids[0];

    // The correction itself was wrong: re-assert the original AGAINST the
    // head. B2 already expresses this intent — no force flag, no ceremony.
    const reassert = await save(SRC, [
      { claim: ORIGINAL, provenance: 'user_stated', supersedes: headId },
    ]);
    expect(reassert.inserted).toBe(1);
    expect(reassert.superseded).toBe(1);
    expect(reassert.duplicate).toBe(0);
    expect(reassert.results[0]).toMatchObject({ index: 0, status: 'inserted' });
    const remintId = reassert.fact_ids[0];
    expect(remintId).not.toBe(originalId);

    // Chain: original → head → re-mint; the re-mint is the live truth.
    const headState = await supersessionState(headId);
    expect(headState.expired_at).not.toBeNull();
    expect(headState.superseded_by).toBe(remintId);
    expect(await activeCount(SRC, ORIGINAL)).toBe(1);
    expect(await activeCount(SRC, CORRECTED)).toBe(0);
  });

  test('same-batch: insert → correct → replay inside ONE batch resolves duplicate_superseded (same-tx visibility)', async () => {
    const SRC = 'tenant-n1-batch';
    const ORIGINAL = 'The retro moved to Thursdays';
    const CORRECTED = 'The retro moved to Fridays';

    // Claim 0 inserts; claim 1 corrects it (insert path — supersedes can name
    // an id from THIS batch because claims process sequentially); claim 2
    // replays the original bytes.
    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const originalId = first.fact_ids[0];

    const batch = await save(SRC, [
      { claim: CORRECTED, provenance: 'user_stated', supersedes: originalId },
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
    expect(batch.inserted).toBe(1);
    expect(batch.duplicate).toBe(1);
    expect(await activeCount(SRC, ORIGINAL)).toBe(0);
  });

  test('chain walk: replay resolves through a multi-step superseded_by chain to the ACTIVE head', async () => {
    const SRC = 'tenant-n1-walk';
    // Lexically DISTANT chain texts, deliberately: a near-dup correction is
    // already caught at the ACTIVE head by Layer-1's trgm arm (a safe plain
    // 'duplicate'); the tombstone lane exists for corrections distant enough
    // to miss active dedup, so that is what this test must exercise.
    const A = 'The all-hands meeting happens on Mondays';
    const B = 'Weekly sync moved to Wednesday afternoons';
    const C = 'Team gathering now occurs each Friday morning';

    const rA = await save(SRC, [{ claim: A, provenance: 'user_stated' }]);
    const idA = rA.fact_ids[0];
    const rB = await save(SRC, [{ claim: B, provenance: 'user_stated', supersedes: idA }]);
    const idB = rB.fact_ids[0];
    const rC = await save(SRC, [{ claim: C, provenance: 'user_stated', supersedes: idB }]);
    const idC = rC.fact_ids[0];

    // A's pointer still names B (each hop stamps only its own target);
    // the walk follows A → B → C and lands on the live head.
    const replay = await save(SRC, [{ claim: A, provenance: 'user_stated' }]);
    expect(replay.results[0]).toMatchObject({
      index: 0,
      status: 'duplicate_superseded',
      fact_id: idC,
      superseded_from: idA,
    });
    expect(await activeCount(SRC, A)).toBe(0);
  });

  test('dead chain: when the correction was itself forgotten (no active head), a replay mints — refusal would make forget sticky', async () => {
    const SRC = 'tenant-n1-dead';
    const ORIGINAL = 'Standup is at 9am';
    const CORRECTED = 'Standup is at 10am';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    const originalId = first.fact_ids[0];
    const corr = await save(SRC, [
      { claim: CORRECTED, provenance: 'user_stated', supersedes: originalId },
    ]);
    const headId = corr.fact_ids[0];

    // The user deletes the correction: the chain now has NO live head.
    const forgot = await forgetFactInFence(engine, headId);
    expect(forgot.ok).toBe(true);

    // There is no live truth to point a duplicate_superseded receipt at;
    // blocking here would make the forget sticky against the original.
    const replay = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated' }]);
    expect(replay.inserted).toBe(1);
    expect(replay.results[0]).toMatchObject({ index: 0, status: 'inserted' });
  });

  test('tombstone matching is normalized-exact (case/whitespace), and a PARAPHRASE still mints — the conceded edge', async () => {
    const SRC = 'tenant-n1-norm';
    const ORIGINAL = 'Lena works from the Berlin office';
    const CORRECTED = 'Lena works from the Lisbon office';

    const first = await save(SRC, [{ claim: ORIGINAL, provenance: 'user_stated', people: ['Lena'] }]);
    const corr = await save(SRC, [
      { claim: CORRECTED, provenance: 'user_stated', people: ['Lena'], supersedes: first.fact_ids[0] },
    ]);
    const headId = corr.fact_ids[0];

    // Same bytes modulo case + whitespace → same normalized key as Layer-1's
    // exact arm → tombstone hit.
    const noisy = await save(SRC, [
      { claim: '  lena WORKS from   the berlin office ', provenance: 'user_stated', people: ['Lena'] },
    ]);
    expect(noisy.results[0]).toMatchObject({ status: 'duplicate_superseded', fact_id: headId });

    // A reworded restatement is NOT blocked (exact-only by design: the
    // replay/retry threat is verbatim; closing paraphrases would cost a
    // second HNSW index — documented in the tool doc).
    const paraphrase = await save(SRC, [
      { claim: 'Lena is based out of the office in Berlin', provenance: 'user_stated', people: ['Lena'] },
    ]);
    expect(paraphrase.inserted).toBe(1);
  });

  test('tombstones are source-scoped: a correction in tenant X never blocks tenant Y', async () => {
    const CLAIM = 'The vendor contract renews in June';
    const x1 = await save('tenant-n1-iso-x', [{ claim: CLAIM, provenance: 'user_stated' }]);
    await save('tenant-n1-iso-x', [
      { claim: 'The vendor contract renews in July', provenance: 'user_stated', supersedes: x1.fact_ids[0] },
    ]);

    const y = await save('tenant-n1-iso-y', [{ claim: CLAIM, provenance: 'user_stated' }]);
    expect(y.inserted).toBe(1);
    expect(y.results[0]).toMatchObject({ index: 0, status: 'inserted' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (a) durable-supersede wiring through save_facts (fence-backed targets)
// ───────────────────────────────────────────────────────────────────────────

const FENCE_BODY = (rows: string): string => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

describe('save_facts — B2 supersede is DURABLE for fence-backed targets (wiring)', () => {
  let brainDir: string;

  async function setLocalPath(path: string | null): Promise<void> {
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [path]);
  }

  async function putPage(slug: string, body: string): Promise<void> {
    await engine.putPage(slug, {
      title: slug,
      type: 'person',
      compiled_truth: body,
      frontmatter: {},
      timeline: '',
    });
  }

  /** Seed a fence-backed fact on disk + DB via the real reconcile path. */
  async function seedFenceFact(slug: string, claim: string): Promise<number> {
    mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
    const body = FENCE_BODY(
      `| 1 | ${claim} | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    );
    writeFileSync(join(brainDir, `${slug}.md`), body, 'utf-8');
    await putPage(slug, body);
    const r = await runExtractFacts(engine, { slugs: [slug] });
    expect(r.factsInserted).toBe(1);
    const rows = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM facts WHERE source_markdown_slug = $1`,
      [slug],
    );
    return Number(rows[0].id);
  }

  async function activeDefault(slug: string): Promise<string[]> {
    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts
       WHERE source_id = 'default' AND entity_slug = $1 AND expired_at IS NULL`,
      [slug],
    );
    return rows.map(r => r.fact);
  }

  test('dedup path: a save_facts correction strikes the fence and SURVIVES a rebuild', async () => {
    brainDir = mkdtempSync(join(tmpdir(), 'n1-wire-dedup-'));
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/wren', 'Wren is the CFO');

    // Canonical corrected text exists first, so the correction batch dedups.
    const canon = await save('default', [
      { claim: 'Wren is the CEO', provenance: 'user_stated', people: ['Wren'] },
    ]);
    const headId = canon.fact_ids[0];

    const corr = await save('default', [
      { claim: 'Wren is the CEO', provenance: 'user_stated', people: ['Wren'], supersedes: targetId },
    ]);
    expect(corr.duplicate).toBe(1);
    expect(corr.superseded).toBe(1);
    // Durable outcome → NO disclosure fields on the receipt (byte-compatible
    // with the pre-wiring shape for every already-green flow).
    expect(corr.results[0]).toMatchObject({ index: 0, status: 'duplicate', fact_id: headId });
    expect((corr.results[0] as Record<string, unknown>).supersede_durable).toBeUndefined();

    // The fence carries the strike + the DB-id marker.
    const fileBody = readFileSync(join(brainDir, 'people/wren.md'), 'utf-8');
    expect(fileBody).toContain('~~Wren is the CFO~~');
    expect(fileBody).toContain(`superseded by fact #${headId}`);
    expect(parseFactsFence(fileBody).facts[0].supersededByFactId).toBe(headId);

    // THE REBUILD (the resurrection class): wipe-and-reinsert from the fence.
    await runExtractFacts(engine, { slugs: ['people/wren'] });
    const active = await activeDefault('people/wren');
    expect(active).not.toContain('Wren is the CFO');
    const reminted = await engine.executeRaw<{ expired_at: unknown; superseded_by: number | string | null }>(
      `SELECT expired_at, superseded_by FROM facts WHERE source_markdown_slug = 'people/wren'`,
    );
    expect(reminted[0].expired_at).not.toBeNull();
    expect(Number(reminted[0].superseded_by)).toBe(headId);
  });

  test('dedup path retry: fence marker is struck ONCE — retry is a full no-op (counter AND bytes)', async () => {
    brainDir = mkdtempSync(join(tmpdir(), 'n1-wire-retry-'));
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/silas', 'Silas leads design');

    await save('default', [
      { claim: 'Silas leads research', provenance: 'user_stated', people: ['Silas'] },
    ]);
    const corr = await save('default', [
      { claim: 'Silas leads research', provenance: 'user_stated', people: ['Silas'], supersedes: targetId },
    ]);
    expect(corr.superseded).toBe(1);
    const struckBytes = readFileSync(join(brainDir, 'people/silas.md'), 'utf-8');

    const retry = await save('default', [
      { claim: 'Silas leads research', provenance: 'user_stated', people: ['Silas'], supersedes: targetId },
    ]);
    expect(retry.superseded).toBe(0);
    expect(retry.duplicate).toBe(1);
    // No second strike, no marker accumulation: byte-identical fence.
    expect(readFileSync(join(brainDir, 'people/silas.md'), 'utf-8')).toBe(struckBytes);
  });

  test('dedup path: when the fence cannot be struck, the receipt DISCLOSES supersede_durable:false + reason', async () => {
    brainDir = mkdtempSync(join(tmpdir(), 'n1-wire-disclose-'));
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/edda', 'Edda owns the roadmap');

    // Delete the fence file out from under the correction: the DB stamp still
    // applies (the user's intent succeeds NOW) but it will NOT survive the
    // next reconcile of that page — the receipt must say so.
    rmSync(join(brainDir, 'people/edda.md'));

    await save('default', [
      { claim: 'Edda owns the budget', provenance: 'user_stated', people: ['Edda'] },
    ]);
    const corr = await save('default', [
      { claim: 'Edda owns the budget', provenance: 'user_stated', people: ['Edda'], supersedes: targetId },
    ]);
    expect(corr.superseded).toBe(1); // applied now — counted honestly
    expect(corr.results[0]).toMatchObject({
      index: 0,
      status: 'duplicate',
      supersede_durable: false,
    });
    const reason = (corr.results[0] as Record<string, unknown>).supersede_reason;
    expect(typeof reason).toBe('string');
    expect((reason as string).length).toBeGreaterThan(0);
  });

  test('insert path: the atomic insert+expire gets a fence FOLLOW-UP strike and survives a rebuild', async () => {
    brainDir = mkdtempSync(join(tmpdir(), 'n1-wire-insert-'));
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/orla', 'Orla is based in Oslo');

    // Fresh text + supersedes → the engine's atomic insert+expire path, then
    // the follow-up fence strike (followUp: true — DB already stamped).
    const corr = await save('default', [
      { claim: 'Orla is based in Madrid', provenance: 'user_stated', people: ['Orla'], supersedes: targetId },
    ]);
    expect(corr.inserted).toBe(1);
    expect(corr.superseded).toBe(1);
    const newId = corr.fact_ids[0];

    const fileBody = readFileSync(join(brainDir, 'people/orla.md'), 'utf-8');
    expect(fileBody).toContain('~~Orla is based in Oslo~~');
    expect(fileBody).toContain(`superseded by fact #${newId}`);

    await runExtractFacts(engine, { slugs: ['people/orla'] });
    const active = await activeDefault('people/orla');
    expect(active).not.toContain('Orla is based in Oslo');
    expect(await activeCount('default', 'Orla is based in Madrid')).toBe(1);
  });
});
