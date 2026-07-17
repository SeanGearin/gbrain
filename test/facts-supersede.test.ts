/**
 * v0.42.24 — durable supersede module (fence-resurrection class,
 * P0 #1 / FS-1 ≡ FE-1).
 *
 * The new-capability half of the fix: `supersedeFactDurably` routes a
 * B2 supersede through the fence when the target is fence-backed
 * (following forget.ts's canFence precedent) and discloses durability
 * honestly when it can't. The red-first proof for the CLASS lives in
 * test/facts-fence-resurrection.test.ts (pre-fix-era modules only);
 * this file pins the module's routing matrix + the end-to-end P0
 * scenario: a fence-backed supersede that SURVIVES a rebuild.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { supersedeFactDurably } from '../src/core/facts/supersede.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'fence-supersede-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
});

async function setLocalPath(path: string | null): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [path]);
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

const FENCE_BODY = (rows: string): string => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawFact = async (id: number): Promise<any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    'SELECT id, fact, expired_at, superseded_by FROM facts WHERE id = $1', [id],
  );
  return r.rows[0];
};

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (engine as any).db.query(
    'SELECT id FROM facts WHERE source_markdown_slug = $1', [slug],
  );
  return Number(rows.rows[0].id);
}

async function insertCorrection(entitySlug: string | null, fact: string): Promise<number> {
  const ins = await engine.insertFact(
    { fact, entity_slug: entitySlug, source: 'mcp:save_facts', client_authored: true },
    { source_id: 'default' },
  );
  return ins.id;
}

describe('supersedeFactDurably — fence route (the P0 #1 scenario)', () => {
  test('fence-backed supersede strikes the fence AND survives a rebuild', async () => {
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/reggie', 'Reggie is CFO');
    const correctionId = await insertCorrection('people/reggie', 'Reggie is CEO');

    // The dedup-path shape: expire the target, point at the correction.
    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: correctionId,
    });
    expect(res.applied).toBe(true);
    expect(res.path).toBe('fence');
    expect(res.durable).toBe(true);

    // Fence carries the strike + the DB-id marker.
    const fileBody = readFileSync(join(brainDir, 'people/reggie.md'), 'utf-8');
    expect(fileBody).toContain('~~Reggie is CFO~~');
    expect(fileBody).toContain(`superseded by fact #${correctionId}`);
    const { facts } = parseFactsFence(fileBody);
    expect(facts[0].supersededByFactId).toBe(correctionId);

    // DB stamped immediately.
    const target = await rawFact(targetId);
    expect(target.expired_at).not.toBeNull();
    expect(Number(target.superseded_by)).toBe(correctionId);

    // THE REBUILD: wipe-and-reinsert from the fence. Pre-fix this
    // resurrected the corrected-away claim active under a new id.
    const r = await runExtractFacts(engine, { slugs: ['people/reggie'] });
    expect(r.guardTriggered).toBe(false);

    const active = await engine.listFactsByEntity('default', 'people/reggie');
    expect(active.map(f => f.fact)).not.toContain('Reggie is CFO');
    expect(active.map(f => f.fact)).toContain('Reggie is CEO');

    // The re-minted struck row keeps the chain to the (stable-id) correction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reminted = await (engine as any).db.query(
      `SELECT expired_at, superseded_by FROM facts WHERE source_markdown_slug = 'people/reggie'`,
    );
    expect(reminted.rows[0].expired_at).not.toBeNull();
    expect(Number(reminted.rows[0].superseded_by)).toBe(correctionId);
  });

  test('follow-up mode: fence strike after the engine already stamped the DB (insert path)', async () => {
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/tom', 'Tom lives in Austin');

    // The insert-path shape: atomic insert+expire already happened.
    const ins = await engine.insertFact(
      { fact: 'Tom lives in Miami', entity_slug: 'people/tom', source: 'mcp:save_facts', client_authored: true },
      { source_id: 'default', supersedeId: targetId },
    );
    expect(ins.status).toBe('superseded');
    const stamped = await rawFact(targetId);
    expect(stamped.expired_at).not.toBeNull();

    // Follow-up: the caller DECLARES this is the insert-path follow-up
    // (followUp: true) — the module verifies the already-stamped chain
    // and strikes the fence, skipping the DB stamp. Without the flag an
    // already-expired target is always a no-op, so a dedup-path retry
    // can never re-strike the fence (N1 wiring, save.ts).
    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: ins.id,
      followUp: true,
    });
    expect(res.applied).toBe(true);
    expect(res.path).toBe('fence');
    expect(res.durable).toBe(true);

    const fileBody = readFileSync(join(brainDir, 'people/tom.md'), 'utf-8');
    expect(fileBody).toContain('~~Tom lives in Austin~~');
    expect(fileBody).toContain(`superseded by fact #${ins.id}`);

    // Survives the rebuild.
    await runExtractFacts(engine, { slugs: ['people/tom'] });
    const active = await engine.listFactsByEntity('default', 'people/tom');
    expect(active.map(f => f.fact)).not.toContain('Tom lives in Austin');
    expect(active.map(f => f.fact)).toContain('Tom lives in Miami');
  });
});

describe('supersedeFactDurably — honest fallback matrix', () => {
  test('NULL-slug target: DB-only IS durable (db_only, durable: true)', async () => {
    const targetId = await insertCorrection('people/zoe', 'Zoe is at Initech');
    const correctionId = await insertCorrection('people/zoe', 'Zoe is at Hooli');

    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: correctionId,
    });
    expect(res.applied).toBe(true);
    expect(res.path).toBe('db_only');
    expect(res.durable).toBe(true);

    const target = await rawFact(targetId);
    expect(target.expired_at).not.toBeNull();
    expect(Number(target.superseded_by)).toBe(correctionId);
  });

  test('fence-backed target with the file deleted: DB stamped, durable: false disclosed', async () => {
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/gone', 'Claim on a deleted file');
    const correctionId = await insertCorrection('people/gone', 'Correction');
    rmSync(join(brainDir, 'people/gone.md'));

    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: correctionId,
    });
    // The correction intent still applies NOW…
    expect(res.applied).toBe(true);
    const target = await rawFact(targetId);
    expect(target.expired_at).not.toBeNull();
    // …but the receipt must say it won't survive a rebuild.
    expect(res.path).toBe('db_fallback');
    expect(res.durable).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  test('fence-backed target with no local_path: db_fallback, durable: false', async () => {
    await setLocalPath(brainDir);
    const targetId = await seedFenceFact('people/thin', 'Thin-client claim');
    const correctionId = await insertCorrection('people/thin', 'Correction');
    await setLocalPath(null);

    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: correctionId,
    });
    expect(res.applied).toBe(true);
    expect(res.path).toBe('db_fallback');
    expect(res.durable).toBe(false);
  });

  test('unknown target: silent no-op (not_found, applied: false)', async () => {
    const res = await supersedeFactDurably(engine, 999999, { supersededByFactId: 1 });
    expect(res.applied).toBe(false);
    expect(res.path).toBe('not_found');
  });

  test('already-expired target with an unrelated chain: no-op (mirrors expireFact)', async () => {
    const targetId = await insertCorrection('people/max', 'Old claim');
    const firstCorrection = await insertCorrection('people/max', 'First correction');
    const secondCorrection = await insertCorrection('people/max', 'Second correction');

    const first = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: firstCorrection,
    });
    expect(first.applied).toBe(true);

    const second = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: secondCorrection,
    });
    expect(second.applied).toBe(false);
    expect(second.path).toBe('already_expired');

    // Chain unchanged.
    const target = await rawFact(targetId);
    expect(Number(target.superseded_by)).toBe(firstCorrection);
  });

  test('fence route preserves bystander rows and pre-existing junk (FE-2 discipline)', async () => {
    await setLocalPath(brainDir);
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const JUNK = 'reviewer note: row 3 pending legal';
    const body = FENCE_BODY(
      `| 1 | Target claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |
| 2 | Bystander claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |
${JUNK}`,
    );
    writeFileSync(join(brainDir, 'people/ivy.md'), body, 'utf-8');
    await putPage('people/ivy', body);
    await runExtractFacts(engine, { slugs: ['people/ivy'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT id FROM facts WHERE source_markdown_slug = 'people/ivy' AND row_num = 1`,
    );
    const targetId = Number(rows.rows[0].id);
    const correctionId = await insertCorrection('people/ivy', 'Corrected claim');

    const res = await supersedeFactDurably(engine, targetId, {
      supersededByFactId: correctionId,
    });
    expect(res.path).toBe('fence');

    const after = readFileSync(join(brainDir, 'people/ivy.md'), 'utf-8');
    expect(after).toContain('~~Target claim~~');
    expect(after).toContain(JUNK);
    expect(after).toContain('| 2 | Bystander claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |');
  });
});
