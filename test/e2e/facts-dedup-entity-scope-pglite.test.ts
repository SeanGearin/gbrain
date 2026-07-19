/**
 * A2 amend (2026-07-18) — the in-lock dedup re-check is ENTITY-SCOPED.
 *
 * R2 found and the verification seat confirmed empirically
 * (sessions/cc-findings_2026-07-18_r2-claims-verification.md, claim 1):
 * 5a771a1's in-lock re-check filtered on source + active + folded text
 * with NO entity predicate, while the extract pipeline's own dedup gate
 * (findCandidateDuplicates) IS entity-prefiltered. A fact whose
 * normalized text already exists under a DIFFERENT entity in the same
 * source passed the pipeline's gate, then was refused by the engine and
 * never written — sequentially, no race needed. The receipt even pointed
 * at the OTHER entity's row. The 5a771a1 commit message documents
 * same-text-different-entity as an accepted RACE residual — the code
 * made it a deterministic drop, contradicting its own message.
 *
 * The amendment: `entity_slug IS NOT DISTINCT FROM ${entitySlug}` in the
 * re-check of BOTH engines (lock keying unchanged). This file is the
 * OFFLINE red-first proof on the PGLite twin — the re-check is the shared
 * semantic across twins ("identical across twins" per 5a771a1's own
 * comment), and a sequential semantic needs no lock. The postgres case
 * rides test/e2e/facts-concurrent-dedup-postgres.test.ts for the box's
 * DATABASE_URL gate.
 *
 * Call shape mirrors the extract-pipeline backstop (resolve → dedup →
 * engine.insertFact with { source_id }) — the affected surface.
 * save_facts is NOT the affected surface (its Layer-1 dedup is
 * text-only by design and swallows cross-entity same-text upstream).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { NewFact } from '../../src/core/engine.ts';

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
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('a2scope', 'A2 Scope', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
});

const TEXT = 'Quarterly revenue target is two million';

// Server-authored shape, like the extract-pipeline backstop: provenance and
// client_authored stay undefined (insertFact persists NULL/FALSE).
function fact(entity_slug: string | null): NewFact {
  return {
    fact: TEXT,
    kind: 'fact',
    entity_slug,
    visibility: 'private',
    context: null,
    source: 'test:a2-entity-scope',
    source_session: null,
    confidence: 0.9,
    embedding: null,
  };
}

async function activeRows(): Promise<Array<{ id: number; entity_slug: string | null }>> {
  return engine.executeRaw<{ id: number; entity_slug: string | null }>(
    `SELECT id, entity_slug FROM facts WHERE source_id = 'a2scope' AND expired_at IS NULL ORDER BY id`,
    [],
  );
}

describe('in-lock dedup re-check is entity-scoped (PGLite twin, sequential)', () => {
  test('same text under two DIFFERENT entities: both insert (the R2-confirmed drop)', async () => {
    const a = await engine.insertFact(fact('people/alice-vane'), { source_id: 'a2scope' });
    expect(a.status).toBe('inserted');

    const b = await engine.insertFact(fact('companies/marsh-co'), { source_id: 'a2scope' });
    // Pre-amend: status 'duplicate' pointing at alice's row — bob's fact
    // silently never written. The pipeline's entity-scoped gate already
    // approved this insert; the engine must not overrule it on text alone.
    expect(b.status).toBe('inserted');
    expect(b.id).not.toBe(a.id);

    const rows = await activeRows();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.entity_slug).sort()).toEqual(['companies/marsh-co', 'people/alice-vane']);
  });

  test('same text, entity vs NO entity: both insert (NULL is DISTINCT from a slug)', async () => {
    const a = await engine.insertFact(fact('people/alice-vane'), { source_id: 'a2scope' });
    expect(a.status).toBe('inserted');
    const b = await engine.insertFact(fact(null), { source_id: 'a2scope' });
    expect(b.status).toBe('inserted');
    expect((await activeRows()).length).toBe(2);
  });

  test('same text, SAME entity: still a duplicate (FS-8 semantic retained)', async () => {
    const a = await engine.insertFact(fact('people/alice-vane'), { source_id: 'a2scope' });
    expect(a.status).toBe('inserted');
    const b = await engine.insertFact(fact('people/alice-vane'), { source_id: 'a2scope' });
    expect(b.status).toBe('duplicate');
    expect(b.id).toBe(a.id);
    expect((await activeRows()).length).toBe(1);
  });

  test('same text, NO entity twice: still a duplicate (NULL IS NOT DISTINCT FROM NULL)', async () => {
    const a = await engine.insertFact(fact(null), { source_id: 'a2scope' });
    expect(a.status).toBe('inserted');
    const b = await engine.insertFact(fact(null), { source_id: 'a2scope' });
    expect(b.status).toBe('duplicate');
    expect(b.id).toBe(a.id);
    expect((await activeRows()).length).toBe(1);
  });

  test('whitespace/case folding still dedups WITHIN an entity', async () => {
    const a = await engine.insertFact(fact('people/alice-vane'), { source_id: 'a2scope' });
    expect(a.status).toBe('inserted');
    const b = await engine.insertFact(
      { ...fact('people/alice-vane'), fact: '  quarterly   Revenue target is two million ' },
      { source_id: 'a2scope' },
    );
    expect(b.status).toBe('duplicate');
    expect(b.id).toBe(a.id);
  });
});
