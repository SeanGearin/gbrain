/**
 * v0.42.24 — fence/DB-split resurrection class (P0 #1, FE-2, FE-3,
 * FE-5, FS-1/FE-1 siblings).
 *
 * RED-FIRST: every test in this file fails against the pre-v0.42.24
 * code and passes after the fix. The class: any DB-only status write
 * against fence-backed rows un-happens or RESURRECTS at reconcile,
 * because
 *   (a) the "expired_at = valid_until + now()" rule cited by older
 *       comments never existed — struck fence rows were re-minted
 *       ACTIVE in `expired_at IS NULL` query terms on every rebuild;
 *   (b) reconcile read the DB page body while the fence writers write
 *       DISK, so out-of-band reconciles erased receipted writes;
 *   (c) fence rewrites re-rendered the whole table from the lenient
 *       parse, silently erasing rows/prose the writer never intended
 *       to touch;
 *   (d) an active claim wrapped in `~~…~~` was born expired with a
 *       success receipt (strikethrough inversion at birth).
 *
 * Uses ONLY pre-fix-era modules (no facts/supersede.ts import) so the
 * whole file runs — red — against the pre-fix tree.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { extractFactsFromFenceText } from '../src/core/facts/extract-from-fence.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';

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
  brainDir = mkdtempSync(join(tmpdir(), 'fence-resurrection-'));
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
    'SELECT id, fact, expired_at, superseded_by, valid_until FROM facts WHERE id = $1', [id],
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

// ─────────────────────────────────────────────────────────────────
// (a) parser + mapper: supersession/forget state must round-trip
// ─────────────────────────────────────────────────────────────────

describe('fence round-trip of status state', () => {
  test('parser recognizes the `superseded by fact #N` DB-id marker', () => {
    const body = FENCE_BODY(
      `| 1 | ~~Reggie is CFO~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-01 | test | superseded by fact #99 |`,
    );
    const { facts, warnings } = parseFactsFence(body);
    expect(warnings).toHaveLength(0);
    expect(facts).toHaveLength(1);
    expect(facts[0].active).toBe(false);
    expect(facts[0].supersededByFactId).toBe(99);
    // Must NOT be confused with the fence-row pointer contract.
    expect(facts[0].supersededBy).toBeUndefined();
  });

  test('mapper derives expired_at + superseded_by for struck rows (the keystone)', () => {
    const body = FENCE_BODY(
      `| 1 | Active claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |
| 2 | ~~Superseded claim~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-01 | test | superseded by fact #42 |
| 3 | ~~Forgotten claim~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-02 | test | forgotten: user asked |`,
    );
    const { facts } = parseFactsFence(body);
    const rows = extractFactsFromFenceText(facts, 'people/reggie', 'default');

    // Active row: no expiry state.
    expect(rows[0].expired_at ?? null).toBeNull();
    expect(rows[0].superseded_by ?? null).toBeNull();

    // Superseded row: expired at its validUntil, chain pointer carried.
    expect(rows[1].expired_at).toBeInstanceOf(Date);
    expect((rows[1].expired_at as Date).toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(rows[1].superseded_by).toBe(42);

    // Forgotten row: expired at its validUntil.
    expect(rows[2].expired_at).toBeInstanceOf(Date);
    expect((rows[2].expired_at as Date).toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  test('mapper stamps struck rows without explicit validUntil as expired today', () => {
    const nowOverride = new Date(Date.UTC(2026, 6, 17));
    const body = FENCE_BODY(
      `| 1 | ~~Hand-struck claim~~ | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    );
    const { facts } = parseFactsFence(body);
    const rows = extractFactsFromFenceText(facts, 'people/reggie', 'default', { nowOverride });
    expect(rows[0].expired_at).toBeInstanceOf(Date);
    expect((rows[0].expired_at as Date).toISOString().slice(0, 10)).toBe('2026-07-17');
  });
});

// ─────────────────────────────────────────────────────────────────
// (a) reconcile: struck fence state survives the wipe-and-reinsert
// ─────────────────────────────────────────────────────────────────

describe('reconcile keeps struck rows expired (resurrection fix)', () => {
  test('a fence forget survives runExtractFacts in DB-active-query terms', async () => {
    await putPage('people/alice', FENCE_BODY(
      `| 1 | Alice lives in Tokyo | fact | 1.0 | world | high | 2026-01-01 |  | test |  |
| 2 | ~~Alice hates async~~ | preference | 0.9 | private | medium | 2026-01-01 | 2026-07-01 | test | forgotten: user asked |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/alice'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.factsInserted).toBe(2);

    // Active-query surface (expired_at IS NULL) must NOT resurrect row 2.
    const active = await engine.listFactsByEntity('default', 'people/alice');
    const activeTexts = active.map(f => f.fact);
    expect(activeTexts).toContain('Alice lives in Tokyo');
    expect(activeTexts).not.toContain('Alice hates async');

    const all = await factsForSlug('people/alice');
    const struck = all.find(f => f.row_num === 2);
    expect(struck.expired_at).not.toBeNull();
  });

  test('a superseded-by-fact strike survives reconcile with its chain intact', async () => {
    // The superseding correction is a DB-only save_facts-shaped row
    // (NULL source_markdown_slug) — its id is stable across rebuilds.
    const correction = await engine.insertFact(
      {
        fact: 'Reggie is CEO',
        entity_slug: 'people/reggie',
        source: 'mcp:save_facts',
        client_authored: true,
      },
      { source_id: 'default' },
    );

    await putPage('people/reggie', FENCE_BODY(
      `| 1 | ~~Reggie is CFO~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-01 | test | superseded by fact #${correction.id} |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/reggie'] });
    expect(r.guardTriggered).toBe(false);

    const all = await factsForSlug('people/reggie');
    expect(all).toHaveLength(1);
    expect(all[0].expired_at).not.toBeNull();
    expect(Number(all[0].superseded_by)).toBe(correction.id);

    // The correction survives the wipe (NULL slug) and stays active.
    const correctionRow = await rawFact(correction.id);
    expect(correctionRow.expired_at).toBeNull();

    // Recall-facing: the corrected-away claim must NOT be active.
    const active = await engine.listFactsByEntity('default', 'people/reggie');
    expect(active.map(f => f.fact)).not.toContain('Reggie is CFO');
    expect(active.map(f => f.fact)).toContain('Reggie is CEO');
  });

  test('a dangling superseded-by-fact pointer degrades to NULL without failing the batch', async () => {
    await putPage('people/dana', FENCE_BODY(
      `| 1 | ~~Old claim~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-01 | test | superseded by fact #999999 |
| 2 | Fresh claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/dana'] });
    expect(r.factsInserted).toBe(2);

    const all = await factsForSlug('people/dana');
    const struck = all.find(f => f.row_num === 1);
    expect(struck.expired_at).not.toBeNull();
    expect(struck.superseded_by).toBeNull();
  });

  test('save_facts client-authored rows do not trip the legacy-migration guard', async () => {
    // B7 rows are entity-slugged + row_num NULL — the exact shape of the
    // pre-B7 legacy guard predicate. One such row used to freeze fence
    // reconciliation for the whole brain.
    await engine.insertFact(
      {
        fact: 'Customer-authored claim',
        entity_slug: 'people/reggie',
        source: 'mcp:save_facts',
        client_authored: true,
      },
      { source_id: 'default' },
    );
    await putPage('people/reggie', FENCE_BODY(
      `| 1 | Fence claim | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    ));

    const r = await runExtractFacts(engine, { slugs: ['people/reggie'] });
    expect(r.guardTriggered).toBe(false);
    expect(r.factsInserted).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// (b) FE-3: reconcile must read the DISK fence, not a stale DB body
// ─────────────────────────────────────────────────────────────────

describe('reconcile reads the disk fence (FE-3)', () => {
  test('disk fence wins over a stale DB compiled_truth', async () => {
    await setLocalPath(brainDir);
    mkdirSync(join(brainDir, 'people'), { recursive: true });

    // DB body is stale: still carries the OLD claim.
    await putPage('people/bob', FENCE_BODY(
      `| 1 | STALE_DB_CLAIM | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    ));
    // Disk fence (what writeFactsToFence / forget actually wrote) has
    // the receipted state: OLD row forgotten + a NEW row appended.
    writeFileSync(join(brainDir, 'people/bob.md'), FENCE_BODY(
      `| 1 | ~~STALE_DB_CLAIM~~ | fact | 1.0 | world | high | 2026-01-01 | 2026-07-01 | test | forgotten: corrected |
| 2 | FRESH_DISK_CLAIM | fact | 1.0 | world | high | 2026-07-01 |  | test |  |`,
    ), 'utf-8');

    const r = await runExtractFacts(engine, { slugs: ['people/bob'] });
    expect(r.factsInserted).toBe(2);

    const active = await engine.listFactsByEntity('default', 'people/bob');
    const texts = active.map(f => f.fact);
    // Pre-fix: reconcile deleted the receipted disk write and
    // resurrected STALE_DB_CLAIM active from the stale DB body.
    expect(texts).toContain('FRESH_DISK_CLAIM');
    expect(texts).not.toContain('STALE_DB_CLAIM');
  });

  test('falls back to the DB body when the source has no local_path', async () => {
    await putPage('people/carl', FENCE_BODY(
      `| 1 | DB_ONLY_CLAIM | fact | 1.0 | world | high | 2026-01-01 |  | test |  |`,
    ));
    const r = await runExtractFacts(engine, { slugs: ['people/carl'] });
    expect(r.factsInserted).toBe(1);
    const active = await engine.listFactsByEntity('default', 'people/carl');
    expect(active.map(f => f.fact)).toContain('DB_ONLY_CLAIM');
  });
});

// ─────────────────────────────────────────────────────────────────
// (c) FE-2: fence rewrites must never erase rows they didn't touch
// ─────────────────────────────────────────────────────────────────

describe('lossless fence rewrites (FE-2)', () => {
  const JUNK_PROSE = 'operator note: verify row 5 with legal before demo';
  const MALFORMED_ROW = `| 5 | Handshake deal with Vandelay | factt | 1.0 | world | high | 2026-01-01 |  | s |  |`;

  test('upsertFactRow preserves malformed rows and prose inside the fence', () => {
    const body = FENCE_BODY(
      `| 1 | Good claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
${MALFORMED_ROW}
${JUNK_PROSE}`,
    );
    const { body: updated, rowNum } = upsertFactRow(body, {
      claim: 'Appended claim',
      kind: 'fact',
      confidence: 1.0,
      visibility: 'world',
      notability: 'medium',
      source: 's',
    });

    // Pre-fix: both lines were silently erased by the whole-fence
    // re-render, and the malformed row's number (5) was re-issued.
    expect(updated).toContain(MALFORMED_ROW);
    expect(updated).toContain(JUNK_PROSE);
    expect(updated).toContain('Appended claim');
    expect(rowNum).toBe(6);

    // The valid pre-existing row is untouched byte-for-byte.
    expect(updated).toContain('| 1 | Good claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |');
  });

  test('forgetFactInFence strikes ONE line and preserves everything else', async () => {
    await setLocalPath(brainDir);
    mkdirSync(join(brainDir, 'people'), { recursive: true });

    const fileBody = FENCE_BODY(
      `| 1 | Target claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | Bystander claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
${MALFORMED_ROW}
${JUNK_PROSE}`,
    );
    writeFileSync(join(brainDir, 'people/erin.md'), fileBody, 'utf-8');
    await putPage('people/erin', fileBody);
    const r = await runExtractFacts(engine, { slugs: ['people/erin'] });
    expect(r.factsInserted).toBe(2); // malformed row warned + skipped

    const all = await factsForSlug('people/erin');
    const target = all.find(f => f.row_num === 1);

    const res = await forgetFactInFence(engine, Number(target.id), { reason: 'test forget' });
    expect(res.ok).toBe(true);
    expect(res.path).toBe('fence');
    expect(res.durable).toBe(true);

    const after = readFileSync(join(brainDir, 'people/erin.md'), 'utf-8');
    // The strike happened…
    expect(after).toContain('~~Target claim~~');
    expect(after).toContain('forgotten: test forget');
    // …and NOTHING else was erased or rewritten.
    expect(after).toContain(MALFORMED_ROW);
    expect(after).toContain(JUNK_PROSE);
    expect(after).toContain('| 2 | Bystander claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |');
  });

  test('writeFactsToFence appends to a damaged fence without erasing it and still inserts', async () => {
    await setLocalPath(brainDir);
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const fileBody = FENCE_BODY(
      `| 1 | Existing claim | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
${MALFORMED_ROW}
${JUNK_PROSE}`,
    );
    writeFileSync(join(brainDir, 'people/finn.md'), fileBody, 'utf-8');

    const { writeFactsToFence } = await import('../src/core/facts/fence-write.ts');
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/finn' },
      [{
        fact: 'Newly appended claim',
        kind: 'fact',
        notability: 'medium',
        source: 'mcp:put_page',
        visibility: 'world',
        confidence: 1.0,
        embedding: null,
        sessionId: null,
      }],
    );

    // The append succeeds (pre-existing damage is not an outage)…
    expect(result.fenceWriteFailed).toBeUndefined();
    expect(result.inserted).toBe(1);

    // …and the damage is preserved, not silently erased (pre-fix the
    // whole-fence re-render dropped both lines and the clean tmp body
    // sailed through the validate gate).
    const after = readFileSync(join(brainDir, 'people/finn.md'), 'utf-8');
    expect(after).toContain(MALFORMED_ROW);
    expect(after).toContain(JUNK_PROSE);
    expect(after).toContain('Newly appended claim');
  });

  test('forget on a non-fence-backed row is honestly durable (NULL slug)', async () => {
    const ins = await engine.insertFact(
      { fact: 'Legacy-shaped claim', entity_slug: null, source: 'cli:think' },
      { source_id: 'default' },
    );
    const res = await forgetFactInFence(engine, ins.id);
    expect(res.ok).toBe(true);
    expect(res.path).toBe('legacy_db');
    // NULL-slug rows are never touched by the reconcile wipe, so the
    // DB-only forget genuinely survives rebuild.
    expect(res.durable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// (d) FE-5: `~~wrapped~~` active claims must not be born expired
// ─────────────────────────────────────────────────────────────────

describe('strikethrough inversion at birth (FE-5)', () => {
  test('an active claim wrapped in ~~…~~ round-trips ACTIVE', () => {
    const { body } = upsertFactRow('# Page\n', {
      claim: '~~Will hit $10M ARR by Q4~~',
      kind: 'commitment',
      confidence: 0.5,
      visibility: 'world',
      notability: 'medium',
      source: 's',
    });
    const { facts, warnings } = parseFactsFence(body);
    expect(warnings).toHaveLength(0);
    expect(facts).toHaveLength(1);
    // Pre-fix: active=false — the fact was saved already-forgotten
    // (in both stores after the expired_at fix) with a success receipt.
    expect(facts[0].active).toBe(true);
    expect(facts[0].claim).toBe('Will hit $10M ARR by Q4');
  });
});
