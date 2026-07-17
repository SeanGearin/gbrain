/**
 * FK-abort residual of the C2 carve-out pair (2026-07-17).
 *
 * RED-FIRST: every test in this file fails at the C2 tip (aedb4c0) and
 * passes after migration v116 rebuilds `facts_superseded_by_fkey` as
 * ON DELETE SET NULL.
 *
 * The class: a wipe-surviving fact row (row_num NULL, no — or a
 * different — source_markdown_slug) whose `superseded_by` points INTO a
 * page's fence-backed row set makes that page's reconcile wipe DELETE
 * violate `facts_superseded_by_fkey` (NO ACTION) → the whole
 * extract_facts phase throws, rolls back, and every page after it in
 * the loop is skipped that run. Producible today by the B2 dedup
 * supersede (save.ts `expireFact(target, { supersededBy: matchedId })`
 * — matchedId is custody-blind and can be fence-backed). Fence-backed
 * ids are ephemeral (wipe-and-reinsert mints new ids every reconcile),
 * so a cross-custody pointer can never be durable; SET NULL is the
 * honest terminal state for the link.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { extractFactsFromFenceText } from '../src/core/facts/extract-from-fence.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
});

async function putPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'person',
    compiled_truth: body,
    frontmatter: {},
    timeline: '',
  });
}

const FENCE_BODY = (rows: string): string => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

/** Seed a fence-backed row set for `slug` exactly as a prior reconcile would have. */
async function seedFenceRows(slug: string, body: string): Promise<number[]> {
  const { facts } = parseFactsFence(body);
  const rows = extractFactsFromFenceText(facts, slug, 'default');
  const { ids } = await engine.insertFacts(rows, { source_id: 'default' });
  return ids;
}

/** A db-only row (row_num NULL, slug NULL, client_authored FALSE — the C2-widened class). */
async function insertDbOnlyRow(entitySlug: string, fact: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, source)
     VALUES ('default', $1, $2, 'mcp:put_page') RETURNING id`,
    [entitySlug, fact],
  );
  return Number(r.rows[0].id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawFact = async (id: number): Promise<any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    'SELECT id, fact, expired_at, superseded_by FROM facts WHERE id = $1', [id],
  );
  return r.rows[0];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const factsForSlug = async (slug: string): Promise<any[]> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `SELECT id, fact, expired_at, superseded_by, row_num FROM facts
      WHERE source_markdown_slug = $1 ORDER BY row_num`, [slug],
  );
  return r.rows;
};

describe('FK-abort residual: wipe vs surviving superseded_by pointers', () => {
  test('reconcile survives a poisoned page and still processes downstream pages', async () => {
    // Page X: fence-backed row S, plus a dead db-only row D whose
    // superseded_by points at S — the exact save.ts B2 product.
    const xBody = FENCE_BODY('| 1 | X is CTO | fact | 1.0 | world | high | 2026-01-01 |  | test |  |');
    await putPage('people/x', xBody);
    const [sId] = await seedFenceRows('people/x', xBody);

    const dId = await insertDbOnlyRow('people/x', 'X is CFO');
    // The producer at save.ts:513 — expire the corrected row, point it at
    // the (fence-backed) canonical dup.
    const applied = await engine.expireFact(dId, { supersededBy: sId });
    expect(applied).toBe(true);

    // Page Y sits AFTER X in the loop — the downstream victim at aedb4c0.
    const yBody = FENCE_BODY('| 1 | Y is CEO | fact | 1.0 | world | high | 2026-01-01 |  | test |  |');
    await putPage('people/y', yBody);

    // At aedb4c0 this rejects: `facts_superseded_by_fkey` violation from
    // page X's wipe DELETE, and page Y is never reconciled.
    const res = await runExtractFacts(engine, { slugs: ['people/x', 'people/y'] });

    expect(res.factsDeleted).toBeGreaterThanOrEqual(1);
    expect(res.factsInserted).toBeGreaterThanOrEqual(2);

    // Downstream page Y got its fence reconciled.
    const yRows = await factsForSlug('people/y');
    expect(yRows.length).toBe(1);
    expect(yRows[0].fact).toBe('Y is CEO');

    // D survived the wipe, stays dead, and its chain link is honestly
    // nulled (the fence row it pointed at no longer exists under that id).
    const d = await rawFact(dId);
    expect(d.expired_at).not.toBeNull();
    expect(d.superseded_by).toBeNull();

    // X's fence row was wiped and reinserted under a NEW id.
    const xRows = await factsForSlug('people/x');
    expect(xRows.length).toBe(1);
    expect(Number(xRows[0].id)).not.toBe(sId);
  });

  test('deleteFactsForPage nulls surviving pointers instead of aborting', async () => {
    const zBody = FENCE_BODY('| 1 | Z is COO | fact | 1.0 | world | high | 2026-01-01 |  | test |  |');
    await putPage('people/z', zBody);
    const [sId] = await seedFenceRows('people/z', zBody);

    const dId = await insertDbOnlyRow('people/z', 'Z is CEO');
    await engine.expireFact(dId, { supersededBy: sId });

    // At aedb4c0 this throws the FK violation.
    const { deleted } = await engine.deleteFactsForPage('people/z', 'default');
    expect(deleted).toBe(1);

    const d = await rawFact(dId);
    expect(d.expired_at).not.toBeNull();
    expect(d.superseded_by).toBeNull();
  });

  test('facts_superseded_by_fkey is ON DELETE SET NULL and carries an RI index', async () => {
    // confdeltype: 'a' = NO ACTION (the defect), 'n' = SET NULL (the fix).
    // migrate.ts is shared by both engine twins, so this pins the shape
    // for pglite AND postgres.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const con = await (engine as any).db.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'facts_superseded_by_fkey' AND conrelid = 'facts'::regclass`,
    );
    expect(con.rows.length).toBe(1);
    expect(con.rows[0].confdeltype).toBe('n');

    // The RI delete-scan index (also serves the NO-ACTION-era scan cost).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = await (engine as any).db.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'facts' AND indexname = 'idx_facts_superseded_by'`,
    );
    expect(idx.rows.length).toBe(1);
  });

  test('v116 heals an FK-less schema: nulls dangling pointers, installs the FK, idempotent', async () => {
    // The v0.31 lesson recorded at the facts DDL: inline REFERENCES was
    // observed silently dropped on the postgres.js unsafe() path — a real
    // box may carry NO self-FK and therefore dangling superseded_by
    // values. v116 must converge that state, not fail on it.
    const m = MIGRATIONS.find(x => x.version === 116);
    expect(m).toBeDefined();
    expect(m!.idempotent).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (engine as any).db;
    await db.query('ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_superseded_by_fkey');
    const dId = await insertDbOnlyRow('people/w', 'W left the company');
    await db.query(
      'UPDATE facts SET expired_at = now(), superseded_by = 999999999 WHERE id = $1', [dId],
    );

    await engine.executeRaw(m!.sql);

    const d = await rawFact(dId);
    expect(d.superseded_by).toBeNull();
    const con = await db.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'facts_superseded_by_fkey' AND conrelid = 'facts'::regclass`,
    );
    expect(con.rows.length).toBe(1);
    expect(con.rows[0].confdeltype).toBe('n');

    // Idempotent re-run must not throw or duplicate anything.
    await engine.executeRaw(m!.sql);
    const con2 = await db.query(
      `SELECT COUNT(*)::int AS n FROM pg_constraint
        WHERE conname = 'facts_superseded_by_fkey' AND conrelid = 'facts'::regclass`,
    );
    expect(Number(con2.rows[0].n)).toBe(1);
  });
});
