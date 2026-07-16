/**
 * save_facts materialize — page-version stamping (the time-travel seam).
 *
 * The worker's pro-time-travel (`open_note_as_of`) reconstructs a note as of a
 * past date from the engine's page version history: the engine snapshots a
 * page's PRE-update state at update time, so a version row at snapshot_at=T
 * holds the content that stood UNTIL T; "as of D" resolves to the earliest
 * snapshot at-or-after D, else the live page — unless the page's updated_at
 * says it changed through a NON-VERSIONING path, which the worker must report
 * as no_history rather than pass off today's text as the past.
 *
 * save_facts' materialize (construct.ts materializeEntityPages) was exactly
 * such a non-versioning path: it rewrites an entity page's compiled_truth via
 * the low-level putPage upsert, so every save_facts batch that touched an
 * entity moved updated_at with no snapshot — permanently poisoning as-of
 * reconstruction for the very pages save_facts keeps current. These tests pin
 * the fix: the materialize rewrite snapshots the pre-update state exactly like
 * the put_page op path (import-file.ts createVersion-on-existing), and mints
 * NO version when it doesn't rewrite (idempotent skip / duplicate claims), so
 * the chain stays 1:1 with real content changes.
 *
 * Runs entirely on PGLite (keyless, in-memory) like facts-construct.test.ts:
 * no embedding provider, so the materialize path exercised here is the same
 * NULL-embedded shape the production tenant box runs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { STUB_MARKER } from '../src/core/facts/construct.ts';

let engine: PGLiteEngine;

const TEST_SOURCES = ['tv-chain', 'tv-idem', 'tv-legacy'];

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

const SLUG = 'companies/boltline';

function claim(text: string) {
  return {
    claim: text,
    entities: ['Boltline'],
    provenance: 'user_stated' as const,
  };
}

/** getVersions rows normalized to what the worker's reconstruction consumes. */
async function versions(sourceId: string) {
  const rows = await engine.getVersions(SLUG, { sourceId });
  return rows.map((v) => ({
    compiled_truth: v.compiled_truth,
    snapshot_at: v.snapshot_at,
  }));
}

describe('save_facts materialize snapshots the pre-update page state', () => {
  const SRC = 'tv-chain';
  const FACT_1 = 'Boltline is negotiating a distribution deal in Ohio';
  const FACT_2 = 'Boltline hired a new head of sales';

  test('first save: the stub the materialize replaced is banked as version 1', async () => {
    const r1 = await runSaveFacts([claim(FACT_1)], { engine, sourceId: SRC });
    expect('inserted' in r1 && r1.inserted).toBe(1);

    const page = await engine.getPage(SLUG, { sourceId: SRC });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain(FACT_1); // live page: materialized fact body

    // THE seam: the rewrite of the just-created stub must snapshot the stub,
    // exactly as the put_page op snapshots an existing page before updating it.
    const vs = await versions(SRC);
    expect(vs.length).toBe(1);
    expect(vs[0].compiled_truth).toContain(STUB_MARKER); // pre-update state = the stub
    expect(vs[0].compiled_truth).not.toContain(FACT_1);  // never the post-state
  });

  test('second save: the prior fact body is banked — as-of ordering is deterministic', async () => {
    const r2 = await runSaveFacts([claim(FACT_2)], { engine, sourceId: SRC });
    expect('inserted' in r2 && r2.inserted).toBe(1);

    const page = await engine.getPage(SLUG, { sourceId: SRC });
    expect(page!.compiled_truth).toContain(FACT_1);
    expect(page!.compiled_truth).toContain(FACT_2);

    const vs = await versions(SRC); // getVersions: snapshot_at DESC
    expect(vs.length).toBe(2);

    // Newest snapshot = the body as it stood UNTIL the second save: fact 1
    // only. Reconstruction for any D between the saves resolves to exactly
    // this row (earliest snapshot at-or-after D) — deterministic, no poison.
    expect(vs[0].compiled_truth).toContain(FACT_1);
    expect(vs[0].compiled_truth).not.toContain(FACT_2);
    // Oldest snapshot stays the stub — the chain is append-only.
    expect(vs[1].compiled_truth).toContain(STUB_MARKER);

    // Worker usability contract (normalizeVersions): every row carries a
    // parseable snapshot_at and a string compiled_truth, newest-first.
    for (const v of vs) {
      expect(typeof v.compiled_truth).toBe('string');
      expect(Number.isFinite(new Date(v.snapshot_at as unknown as string).getTime())).toBe(true);
    }
    const t0 = new Date(vs[0].snapshot_at as unknown as string).getTime();
    const t1 = new Date(vs[1].snapshot_at as unknown as string).getTime();
    expect(t0).toBeGreaterThanOrEqual(t1);
  });
});

describe('no version spam: only a real rewrite mints a snapshot', () => {
  const SRC = 'tv-idem';
  const FACT = 'Boltline opened a Columbus office';

  test('duplicate claim re-save and identical-body materialize mint nothing', async () => {
    const r1 = await runSaveFacts([claim(FACT)], { engine, sourceId: SRC });
    expect('inserted' in r1 && r1.inserted).toBe(1);
    const after1 = (await versions(SRC)).length;
    expect(after1).toBe(1); // the stub snapshot from the first materialize

    // Same claim again: dedup makes it a duplicate — no insert, no touched
    // entity, no rewrite. The version chain must not grow.
    const r2 = await runSaveFacts([claim(FACT)], { engine, sourceId: SRC });
    expect('duplicate' in r2 && r2.duplicate).toBe(1);
    const after2 = (await versions(SRC)).length;
    expect(after2).toBe(after1);
  });
});

describe('legacy versionless rewrites (back-compat)', () => {
  const SRC = 'tv-legacy';
  const FACT_A = 'Boltline signed a supplier agreement';
  const FACT_B = 'Boltline renewed its warehouse lease';
  const POISONED_BODY =
    '# Boltline\n\n**Type:** Company\n\n## Facts\n\n- legacy body written by a pre-fix versionless rewrite\n\n## Timeline\n';

  test('first post-fix save banks the previously-unversioned state', async () => {
    await runSaveFacts([claim(FACT_A)], { engine, sourceId: SRC });

    // Simulate the PRE-FIX materialize: a low-level putPage rewrite with no
    // snapshot (exactly what shipped) — the page moves, the chain does not.
    await engine.putPage(
      SLUG,
      {
        title: 'Boltline',
        type: 'company',
        compiled_truth: POISONED_BODY,
        timeline: '',
        frontmatter: { source: 'mcp:save_facts' },
      },
      { sourceId: SRC },
    );
    const before = await versions(SRC);
    expect(before.some((v) => v.compiled_truth === POISONED_BODY)).toBe(false);

    // First post-fix save that rewrites the page: the poisoned (unversioned)
    // state must be banked as the pre-update snapshot, so reconstruction is
    // whole again for every as-of from this rewrite forward. The gap BEFORE
    // this point stays honestly disclosed by the worker (updated_at moved
    // with no covering snapshot → no_history), never served as today's text.
    await runSaveFacts([claim(FACT_B)], { engine, sourceId: SRC });
    const after = await versions(SRC);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].compiled_truth).toBe(POISONED_BODY);

    const page = await engine.getPage(SLUG, { sourceId: SRC });
    expect(page!.compiled_truth).toContain(FACT_B);
  });
});
