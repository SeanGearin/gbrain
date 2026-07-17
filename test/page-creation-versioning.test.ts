/**
 * Page creation banks a creation-origin version row (the time-travel first-window unlock).
 *
 * The worker's pro-time-travel (`open_note_as_of`) refuses any as-of strictly
 * before a page's earliest banked snapshot, because pre-fix the engine banked
 * versions ONLY on update-of-existing (`if (existing) createVersion` at every
 * import site): a page's creation state was never banked, version rows carried
 * no origin marker, and the wire could not distinguish
 *   (a) a new page whose earliest snapshot genuinely holds the creation state
 * from
 *   (b) a legacy page whose earliest snapshot silently absorbed unbanked
 *       pre-versioning rewrites.
 * So the worker refuses both — honest, but it swallows a genuinely-new page's
 * creation→first-snapshot era.
 *
 * These tests pin the unlock: every page-creation path banks a version row of
 * the just-created state in the same engine call, stamped `origin='creation'`
 * (page_versions.origin, DEFAULT 'update'). The worker's read contract:
 *
 *   rows = get_versions(slug); oldest = rows[rows.length-1]  // snapshot_at DESC, id DESC
 *   history_complete_from_creation = (oldest.origin === 'creation')
 *
 * When the oldest row is a creation row, the creation→first-rewrite window is
 * bounded on BOTH edges by recorded events (the creation row below, the next
 * snapshot above) — the same epistemic class as every other bounded window,
 * covered by the worker's existing lost-interior-rewrite caveat. When it is
 * not (every legacy page: origin backfills to 'update', which is factually
 * what banked those rows), the worker keeps refusing — the signal cannot lie
 * for pages that genuinely have unbounded gaps.
 *
 * The worker must key on `origin`, NEVER on snapshot_at == created_at:
 * timestamp equality holds only where creation + banking share a real
 * transaction (import paths on both engines; construct's ensureStub on
 * Postgres b7 scope) — PGLite's withSourceScope is a pass-through, so the
 * stub path's snapshot_at can trail created_at by call latency there.
 *
 * Runs entirely on PGLite (keyless, in-memory), no embedding provider.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  importFromContent,
  importCodeFile,
  withImportTransaction,
} from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** getVersions rows normalized to what the worker's reconstruction consumes. */
async function versions(slug: string) {
  const rows = await engine.getVersions(slug);
  return rows.map((v) => ({
    id: v.id,
    origin: v.origin,
    compiled_truth: v.compiled_truth,
    snapshot_at: v.snapshot_at,
  }));
}

const MD_BODY_V1 = `---
type: concept
title: Creation Era Note
---

The note as it stood at birth.
`;

const MD_BODY_V2 = `---
type: concept
title: Creation Era Note
---

The note after its first edit.
`;

describe('markdown import (the put_page op path) banks the creation state', () => {
  const SLUG = 'concepts/creation-era-note';

  test('a new page is born with exactly one version row: its creation snapshot', async () => {
    const r = await importFromContent(engine, SLUG, MD_BODY_V1, { noEmbed: true });
    expect(r.status).toBe('imported');

    const vs = await versions(SLUG);
    // THE unlock: pre-fix this was [] — the creation era had no banked floor,
    // so the worker had to refuse every as-of before the first update's
    // snapshot. Post-fix the just-created state is banked in the same
    // transaction that created the page.
    expect(vs.length).toBe(1);
    expect(vs[0].origin).toBe('creation');
    expect(vs[0].compiled_truth).toContain('as it stood at birth');

    // Same-transaction now() (tx-frozen on both engines for the import
    // paths): the creation row self-locates at the page's birth instant.
    const page = await engine.getPage(SLUG);
    expect(new Date(vs[0].snapshot_at as unknown as string).getTime()).toBe(
      new Date(page!.created_at as unknown as string).getTime(),
    );
  });

  test('the first edit banks the pre-update state; the chain is bounded from birth', async () => {
    const r = await importFromContent(engine, SLUG, MD_BODY_V2, { noEmbed: true });
    expect(r.status).toBe('imported');

    const vs = await versions(SLUG); // snapshot_at DESC, id DESC
    expect(vs.length).toBe(2);

    // Newest row: the update bank — the content that stood UNTIL the edit
    // (which IS the creation body; nothing rewrote it in between).
    expect(vs[0].origin).toBe('update');
    expect(vs[0].compiled_truth).toContain('as it stood at birth');

    // Oldest row: the creation row. The worker's completeness signal:
    // oldest.origin === 'creation' → the creation→first-edit window is
    // bounded [creation row, update row] and serves honestly.
    expect(vs[1].origin).toBe('creation');
    expect(vs[1].compiled_truth).toContain('as it stood at birth');

    const oldest = vs[vs.length - 1];
    expect(oldest.origin).toBe('creation');
    expect(vs.filter((v) => v.origin === 'creation').length).toBe(1);
  });
});

describe('code import path banks the creation state', () => {
  test('a new code page is born with its creation snapshot', async () => {
    const r = await importCodeFile(engine, 'src/widgets/frobnicator.ts', 'export const x = 1;\n', {
      noEmbed: true,
    });
    expect(r.status).toBe('imported');

    const vs = await versions(r.slug);
    expect(vs.length).toBe(1);
    expect(vs[0].origin).toBe('creation');
    expect(vs[0].compiled_truth).toContain('export const x = 1;');
  });
});

describe('shared import transaction (markdown/image wrapper) banks the creation state', () => {
  const SLUG = 'images/example-diagram';

  test('hadExisting=false births the page with a creation row', async () => {
    await withImportTransaction(engine, {
      slug: SLUG,
      hadExisting: false,
      page: {
        type: 'image',
        title: 'Example Diagram',
        compiled_truth: 'An example diagram page body.',
        timeline: '',
        frontmatter: {},
      },
    });

    const vs = await versions(SLUG);
    expect(vs.length).toBe(1);
    expect(vs[0].origin).toBe('creation');
    expect(vs[0].compiled_truth).toBe('An example diagram page body.');
  });

  test('hadExisting=true keeps the pre-update contract (no creation row minted)', async () => {
    await withImportTransaction(engine, {
      slug: SLUG,
      hadExisting: true,
      page: {
        type: 'image',
        title: 'Example Diagram',
        compiled_truth: 'The diagram page after a re-import.',
        timeline: '',
        frontmatter: {},
      },
    });

    const vs = await versions(SLUG);
    expect(vs.length).toBe(2);
    expect(vs[0].origin).toBe('update'); // pre-update bank of the birth body
    expect(vs[0].compiled_truth).toBe('An example diagram page body.');
    expect(vs[1].origin).toBe('creation');
  });
});

describe('legacy pages never claim completeness (back-compat)', () => {
  const SLUG = 'concepts/legacy-era-note';

  test('a page created through an uninstrumented path has no creation row — the worker keeps refusing', async () => {
    // Exactly what every pre-fix page did at birth (and what uninstrumented
    // system paths — synthesize, output writer, receipts — still do): a
    // direct putPage with no banking. The chain floor is unrecorded.
    await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Legacy Era Note',
      compiled_truth: 'Legacy body that predates creation banking.',
      timeline: '',
      frontmatter: {},
    });
    expect((await versions(SLUG)).length).toBe(0);

    // A later edit through the instrumented path banks the pre-update state
    // as an ordinary update row — never retroactively claims creation.
    const r = await importFromContent(
      engine,
      SLUG,
      `---\ntype: concept\ntitle: Legacy Era Note\n---\n\nEdited legacy body.\n`,
      { noEmbed: true },
    );
    expect(r.status).toBe('imported');

    const vs = await versions(SLUG);
    expect(vs.length).toBe(1);
    expect(vs[0].origin).toBe('update');
    expect(vs.some((v) => v.origin === 'creation')).toBe(false);
  });

  test('pre-fix version rows read origin=update — the migration backfill semantics', async () => {
    // A raw origin-less INSERT is byte-for-byte what every pre-migration row
    // looks like after `ALTER TABLE ... ADD COLUMN origin ... DEFAULT 'update'`
    // backfills it: 'update' is factually correct for every legacy row (they
    // were all banked by update-of-existing, revert, or migrate-engine).
    const page = await engine.getPage(SLUG);
    await engine.executeRaw(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       VALUES ($1, $2, '{}'::jsonb)`,
      [page!.id, 'A row banked by pre-fix code.'],
    );
    const rows = await engine.executeRaw<{ origin: string }>(
      `SELECT origin FROM page_versions WHERE compiled_truth = $1`,
      ['A row banked by pre-fix code.'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].origin).toBe('update');
  });
});
