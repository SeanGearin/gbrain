/**
 * Re-materialize the affected entity page on the expire path (RED-B, engine
 * half — PACKET ENGINE-PREP 2026-07-20, FIX 1).
 *
 * The live defect this pins (cc-findings_2026-07-20_engine-preshoot RED-B):
 * expiring a fact (forget / supersede) flips `facts.expired_at` and clears the
 * query cache, but NEVER re-materializes the affected entity page. The page's
 * `compiled_truth` + its `content_chunks` keep the stale value verbatim, and the
 * CHUNK arm of `find_in_record` (the tenant `query` op → searchKeyword /
 * searchVector over content_chunks) has NO `expired_at` filter and NO join to
 * facts — so "forget everything about X" still returns X via meaning search, and
 * a cross-subject correction (I→Google→Meta) still surfaces the old company.
 *
 * The fix (this file goes RED on 67ec1a1, GREEN after):
 *   - construct.ts materializeEntityPages: when an entity has ZERO active facts,
 *     rebuild it to a stub (compileEntityBody([])) and DELETE-replace its chunks,
 *     instead of leaving the stale materialized body untouched.
 *   - forget.ts: after a real expire, re-materialize the target's entity page.
 *   - supersede.ts: return the target's entity_slug so save.ts re-materializes it
 *     (the old page, which may differ from the new fact's page on a cross-subject
 *     correction).
 *
 * A still-referenced entity KEEPS its page (regression guard below) — the blank
 * fires only on a genuinely emptied, construct-owned page.
 *
 * PGLite, in-memory, no provider keys — the chunk arm is keyword-searchable
 * immediately via the search_vector trigger (no embeddings needed). Distinctive
 * NON-name value tokens (Falcon-9931, Aurora-7742) avoid the co-occurrence
 * stub-name confound (searching a bare entity name would title-match its stub).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { STUB_MARKER } from '../src/core/facts/construct.ts';

let engine: PGLiteEngine;
const SRC = 'tenant-rematerialize';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    [SRC],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

async function entitySlugOf(factId: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ entity_slug: string | null }>(
    `SELECT entity_slug FROM facts WHERE id = $1`,
    [factId],
  );
  return rows[0]?.entity_slug ?? null;
}

async function chunkTextFor(slug: string): Promise<string> {
  const chunks = await engine.getChunks(slug, { sourceId: SRC });
  return chunks.map((c) => c.chunk_text).join('\n');
}

describe('expire path re-materializes the affected entity (RED-B)', () => {
  test('forget: the forgotten value stops surfacing via the chunk arm; page blanks to a stub', async () => {
    const save = await runSaveFacts(
      [{
        claim: "Ishaan's employer is Northwind and his badge code is Falcon-9931",
        people: ['Ishaan'],
        provenance: 'user_stated',
      }],
      { engine, sourceId: SRC },
    );
    expect('error' in save).toBe(false);
    if ('error' in save) return;
    const factId = save.fact_ids[0];
    const slug = await entitySlugOf(factId);
    expect(slug).not.toBeNull();

    // GREEN precondition: the materialized page carries the value, and the chunk
    // arm finds it. (Proves the leak surface exists before we forget.)
    expect(await chunkTextFor(slug!)).toContain('Falcon-9931');
    const preHits = await engine.searchKeyword('Falcon-9931', { sourceId: SRC });
    expect(preHits.some((h) => h.slug === slug)).toBe(true);

    // Forget the fact (save_facts rows are DB-only → legacy expireFact path).
    const forgot = await forgetFactInFence(engine, factId);
    expect(forgot.ok).toBe(true);

    // Control: the facts arm already dropped it (expired_at filter) — proves the
    // leak was chunk-arm-only.
    const active = await engine.listFactsByEntity(SRC, slug!, { activeOnly: true, limit: 100 });
    expect(active.length).toBe(0);

    // THE FIX: the chunk arm no longer returns the forgotten value, and the
    // page body is blanked to a stub (no fact substance).
    expect(await chunkTextFor(slug!)).not.toContain('Falcon-9931');
    const postHits = await engine.searchKeyword('Falcon-9931', { sourceId: SRC });
    expect(postHits.some((h) => h.slug === slug)).toBe(false);
    const page = await engine.getPage(slug!, { sourceId: SRC });
    expect(page!.compiled_truth).not.toContain('Falcon-9931');
    expect(page!.compiled_truth).toContain(STUB_MARKER);
  });

  test('still-referenced entity KEEPS its page when only one of its facts is forgotten', async () => {
    const save = await runSaveFacts(
      [
        { claim: 'Priya has security clearance code Raptor-3310', people: ['Priya'], provenance: 'user_stated' },
        { claim: 'Priya is the lead reliability engineer on the payments team', people: ['Priya'], provenance: 'user_stated' },
      ],
      { engine, sourceId: SRC },
    );
    expect('error' in save).toBe(false);
    if ('error' in save) return;
    const clearanceId = save.fact_ids[0];
    const slug = await entitySlugOf(clearanceId);
    expect(slug).not.toBeNull();

    // Forget only the clearance-code fact.
    const forgot = await forgetFactInFence(engine, clearanceId);
    expect(forgot.ok).toBe(true);

    // The page survives with its OTHER fact's substance; it is NOT a stub.
    const body = await chunkTextFor(slug!);
    expect(body).toContain('lead reliability engineer');
    expect(body).not.toContain('Raptor-3310');
    const page = await engine.getPage(slug!, { sourceId: SRC });
    expect(page!.compiled_truth).toContain('## Facts');
    expect(page!.compiled_truth).not.toContain(STUB_MARKER);
    // And the retained fact is still findable via the chunk arm.
    const hits = await engine.searchKeyword('reliability engineer', { sourceId: SRC });
    expect(hits.some((h) => h.slug === slug)).toBe(true);
  });

  test('cross-subject supersede: the OLD entity page stops surfacing the corrected-away value', async () => {
    const first = await runSaveFacts(
      [{ claim: 'Northwind Traders sponsors the Aurora-7742 initiative', entities: ['Northwind Traders'], provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    const oldId = first.fact_ids[0];
    const slugOld = await entitySlugOf(oldId);
    expect(slugOld).not.toBeNull();
    expect(await chunkTextFor(slugOld!)).toContain('Aurora-7742');

    // Correct it to a DIFFERENT sponsor — new fact anchors a different entity.
    const second = await runSaveFacts(
      [{ claim: 'Globex Corporation sponsors the Aurora-7742 initiative', entities: ['Globex Corporation'], supersedes: oldId, provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    const newId = second.fact_ids[0];
    const slugNew = await entitySlugOf(newId);
    expect(slugNew).not.toBeNull();
    // Precondition for this test's premise: the correction moved entities.
    expect(slugNew).not.toBe(slugOld);

    // THE FIX (Part A + Part B): the OLD entity's page no longer surfaces the
    // corrected-away value; the NEW entity carries it.
    expect(await chunkTextFor(slugOld!)).not.toContain('Aurora-7742');
    const hits = await engine.searchKeyword('Aurora-7742', { sourceId: SRC });
    expect(hits.some((h) => h.slug === slugNew)).toBe(true);
    expect(hits.some((h) => h.slug === slugOld)).toBe(false);
  });
});
