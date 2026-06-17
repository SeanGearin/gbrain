/**
 * Facts-vector search arm (fix C) — engine-level unit + cross-tenant isolation.
 *
 * Runs entirely on PGLite (in-memory, no DATABASE_URL, no provider keys). We
 * can't call the embedding provider here, so facts are seeded via runSaveFacts
 * (which lands them NULL-embedding, the deterministic zero-LLM intake) and then
 * their embeddings are INJECTED directly with deterministic basis vectors. The
 * query vector is likewise a basis vector — so "nearest fact" is exact and
 * provider-free, isolating the SQL + source-scoping + result-mapping under test.
 *
 * What this asserts:
 *   1. searchFactsVector returns the actual FACT text (chunk_text), typed 'fact',
 *      ranked by vector proximity — i.e. fact substance, not an entity stub.
 *   2. Cross-tenant isolation: tenant A's search returns ZERO of tenant B's
 *      facts, even when B holds a byte-identical-embedding fact. Source-scoped.
 *   3. Fusion-safety: fact rows carry a NEGATIVE synthetic chunk_id so they can
 *      never collide with a (positive) content_chunks id in RRF / cosineReScore.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;
let DIM = 1536;

const SRC_A = 'tc-fv-a';
const SRC_B = 'tc-fv-b';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [SRC_A, SRC_B]) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
  // Read the facts.embedding vector dimension this brain was built with so the
  // injected + query vectors match the column width (avoids a ::vector reject).
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'facts' AND a.attname = 'embedding' AND a.attnum > 0`,
  );
  const m = /vector\((\d+)\)/.exec(rows[0]?.t ?? '');
  DIM = m ? Number(m[1]) : 1536;
});

afterAll(async () => {
  await engine.disconnect();
});

/** A deterministic unit basis vector (1 in slot `hot`, 0 elsewhere). */
function basis(hot: number): number[] {
  const v = new Array(DIM).fill(0);
  v[hot] = 1;
  return v;
}
function lit(v: number[]): string {
  return '[' + v.join(',') + ']';
}

/** Seed one fact and inject a deterministic embedding; return its id. */
async function seedFact(sourceId: string, claim: string, hot: number): Promise<number> {
  const res = await runSaveFacts(
    [{ claim, provenance: 'user_stated' }],
    { engine, sourceId },
  );
  if ('error' in res) throw new Error(`seed failed: ${JSON.stringify(res)}`);
  const rows = await engine.executeRaw<{ id: number; fact: string }>(
    `SELECT id, fact FROM facts WHERE source_id = $1 AND fact ILIKE $2 ORDER BY id DESC LIMIT 1`,
    [sourceId, `%${claim.split(' ')[0]}%`],
  );
  const id = rows[0]?.id;
  if (id == null) throw new Error(`fact not found after seed for "${claim}"`);
  await engine.executeRaw(
    `UPDATE facts SET embedding = $1::vector, embedded_at = now() WHERE id = $2`,
    [lit(basis(hot)), id],
  );
  return Number(id);
}

describe('searchFactsVector — substance + source isolation', () => {
  let aSightlineId = 0;

  beforeAll(async () => {
    // Tenant A: a Sightline fact (slot 0) + an unrelated fact (slot 1).
    aSightlineId = await seedFact(SRC_A, 'Sightline is raising a Series A at a 40 million valuation', 0);
    await seedFact(SRC_A, 'Dentist appointment moved to Thursday morning', 1);
    // Tenant B: a Sightline fact with the SAME embedding as A's (slot 0). Only
    // source-scoping — not vector distance — may keep it out of A's results.
    await seedFact(SRC_B, 'Sightline closed the Boltline acquisition last quarter', 0);
  });

  test('returns the actual fact substance (not just an entity stub), typed fact', async () => {
    const query = Float32Array.from(basis(0)); // nearest to the Sightline facts
    const hits = await engine.searchFactsVector(query, { sourceId: SRC_A, limit: 10 });

    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    // The top hit is tenant A's Sightline fact — and it carries the FACT TEXT.
    expect(top.source_id).toBe(SRC_A);
    expect(top.type).toBe('fact');
    expect(/sightline/i.test(top.chunk_text)).toBe(true);
    expect(/series a/i.test(top.chunk_text)).toBe(true);
    // Ranked above the unrelated (orthogonal-embedding) fact.
    const unrelatedRank = hits.findIndex(h => /dentist/i.test(h.chunk_text));
    if (unrelatedRank !== -1) expect(unrelatedRank).toBeGreaterThan(0);
  });

  test('CROSS-TENANT ISOLATION: tenant A search returns zero of tenant B facts', async () => {
    const query = Float32Array.from(basis(0)); // identical to B's Sightline embedding
    const hits = await engine.searchFactsVector(query, { sourceId: SRC_A, limit: 50 });

    // Not one row may belong to another tenant, and B's Boltline fact (same
    // embedding as A's top hit) must be absent despite being a perfect match.
    expect(hits.every(h => h.source_id === SRC_A)).toBe(true);
    expect(hits.some(h => /boltline/i.test(h.chunk_text))).toBe(false);

    // Symmetric: tenant B cannot see A's facts either.
    const bHits = await engine.searchFactsVector(query, { sourceId: SRC_B, limit: 50 });
    expect(bHits.every(h => h.source_id === SRC_B)).toBe(true);
    expect(bHits.some(h => /series a/i.test(h.chunk_text))).toBe(false);
  });

  test('fact rows carry a negative synthetic chunk_id (RRF / cosineReScore safe)', async () => {
    const hits = await engine.searchFactsVector(Float32Array.from(basis(0)), { sourceId: SRC_A, limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    // Negative → can never collide with a positive content_chunks id, so the
    // fused pipeline keys them distinctly and cosineReScore leaves them be.
    expect(hits.every((h: SearchResult) => h.chunk_id < 0)).toBe(true);
    // chunk_source compiled_truth so the compiled-truth boost + guarantee treat
    // fact substance as primary content.
    expect(hits[0].chunk_source).toBe('compiled_truth');
  });
});
