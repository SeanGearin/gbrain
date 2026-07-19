/**
 * P1 cross-app recall lag (2026-07-19) — fact writes must invalidate the
 * semantic query cache.
 *
 * The live defect: the query cache's freshness gate (query-cache-gate.ts)
 * watches only pages.generation. Fact writes never advance it, so a query
 * cached BEFORE a save kept serving the pre-save result set for up to its
 * TTL (default 3600s) while recall saw the new row instantly — "said it in
 * one app, invisible from another" on the customer plane (facts 8943/8947,
 * tenant t-sstqzhohq3pkkfnb, 2026-07-19; live repro on the operator brain:
 * byte-identical cached rows served 3+ minutes post-save while a cache-miss
 * phrasing surfaced the fact immediately).
 *
 * RED-FIRST: at the pre-fix base every "miss after write" expectation below
 * fails (the lookup still HITs the stale row). The engine-level
 * invalidateQueryCacheForFacts calls turn them green. The recall-immediacy
 * and cross-source-isolation tests are green on both sides (they pin the
 * no-lag path and the blast radius, not the bug).
 *
 * PGLite-backed; synthetic embeddings (no external provider), following
 * test/query-cache.test.ts conventions.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;

const DIM = 1536;
const SRC_A = 'p1-tenant-a';
const SRC_B = 'p1-tenant-b';

function makeEmbedding(seed: number, dim = DIM): Float32Array {
  const e = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    e[i] = Math.sin(seed * 0.001 + i * 0.01);
  }
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeResult(slug: string, pageId: number): SearchResult {
  return {
    slug,
    page_id: pageId,
    title: `Title for ${slug}`,
    type: 'concept',
    chunk_text: `chunk text for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
  };
}

const META: HybridSearchMeta = {
  vector_enabled: true,
  detail_resolved: 'medium',
  expansion_applied: false,
  intent: 'general',
};

// Prime the cache the way the live defect was primed: a row whose results
// reference a REAL page (non-empty page_generations snapshot), stored under
// the mutating source. A non-empty snapshot is the survival path the live
// repro proved — Layer 1 falls through on any page write, but Layer 2 passes
// while the row's OWN pages are untouched, so only the fact-write
// invalidation (the fix) can retire it.
interface Primed { emb: Float32Array; text: string }

async function primeCache(cache: SemanticQueryCache, sourceId: string, seed: number): Promise<Primed> {
  const slug = `${sourceId}-anchor-${seed}`;
  const page = await engine.putPage(
    slug,
    {
      type: 'concept',
      title: `Anchor ${seed}`,
      compiled_truth: `anchor body for cache snapshot ${seed}`,
    },
    { sourceId },
  );
  const emb = makeEmbedding(seed);
  const text = `p1 primed query ${seed}`;
  await cache.store(text, emb, [makeResult(slug, page.id)], META, { sourceId });
  // lookup carries queryText: the store-era cache matched on embedding
  // radius alone, but the F5 text gate (this lineage) also requires the
  // normalized query text — the same-phrasing re-ask, which is exactly the
  // live repro shape (identical text polled NOT-FOUND until the cache died).
  const pre = await cache.lookup(emb, { sourceId, queryText: text });
  if (!pre.hit) throw new Error('primeCache: cache must HIT before the fact write for the test to mean anything');
  return { emb, text };
}

beforeAll(async () => {
  // Pin the gateway to 1536d so query_cache.embedding sizing is hermetic
  // regardless of cross-file shard state (see query-cache.test.ts note).
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // facts.source_id carries an FK to sources — register the two test
  // sources up front (the brain-writer test convention).
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)
     ON CONFLICT (id) DO NOTHING`,
    [SRC_A, SRC_B],
  );
});

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM query_cache`);
});

describe('fact writes invalidate the semantic query cache (P1 recall lag)', () => {
  test('insertFact (plain) retires the source cache rows', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    const primed = await primeCache(cache, SRC_A, 101);

    await engine.insertFact(
      { fact: 'p1 probe: the next calibration is March 14th', source: 'test:p1' },
      { source_id: SRC_A },
    );

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(false);
  });

  test('insertFact (supersede path) retires the source cache rows', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    const { id: oldId } = await engine.insertFact(
      { fact: 'p1 probe: old value', source: 'test:p1' },
      { source_id: SRC_A },
    );
    const primed = await primeCache(cache, SRC_A, 102);

    await engine.insertFact(
      { fact: 'p1 probe: corrected value', source: 'test:p1' },
      { source_id: SRC_A, supersedeId: oldId },
    );

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(false);
  });

  test('expireFact retires the owning source cache rows', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    const { id } = await engine.insertFact(
      { fact: 'p1 probe: to be expired', source: 'test:p1' },
      { source_id: SRC_A },
    );
    const primed = await primeCache(cache, SRC_A, 103);

    const changed = await engine.expireFact(id);
    expect(changed).toBe(true);

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(false);
  });

  test('expireFact on an already-expired fact leaves the cache alone', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    const { id } = await engine.insertFact(
      { fact: 'p1 probe: expire twice', source: 'test:p1' },
      { source_id: SRC_A },
    );
    await engine.expireFact(id);
    const primed = await primeCache(cache, SRC_A, 104);

    const changed = await engine.expireFact(id);
    expect(changed).toBe(false);

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(true);
  });

  test('insertFacts (fence batch) retires the source cache rows', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    const primed = await primeCache(cache, SRC_A, 105);

    await engine.insertFacts(
      [{
        fact: 'p1 probe: fence-reconciled fact',
        source: 'fence:test',
        row_num: 1,
        source_markdown_slug: `${SRC_A}-anchor-105`,
      }],
      { source_id: SRC_A },
    );

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(false);
  });

  test('deleteFactsForPage retires the source cache rows', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: true });
    await engine.insertFacts(
      [{
        fact: 'p1 probe: page-owned fact',
        source: 'fence:test',
        row_num: 1,
        source_markdown_slug: 'p1-owned-page',
      }],
      { source_id: SRC_A },
    );
    const primed = await primeCache(cache, SRC_A, 106);

    const { deleted } = await engine.deleteFactsForPage('p1-owned-page', SRC_A);
    expect(deleted).toBe(1);

    const post = await cache.lookup(primed.emb, { sourceId: SRC_A, queryText: primed.text });
    expect(post.hit).toBe(false);
  });

  test('blast radius: a fact write in source A leaves source B cache rows serving', async () => {
    const cacheA = new SemanticQueryCache(engine, { enabled: true });
    const cacheB = new SemanticQueryCache(engine, { enabled: true });
    await primeCache(cacheA, SRC_A, 107);
    const primedB = await primeCache(cacheB, SRC_B, 108);

    await engine.insertFact(
      { fact: 'p1 probe: A-only write', source: 'test:p1' },
      { source_id: SRC_A },
    );

    const postB = await cacheB.lookup(primedB.emb, { sourceId: SRC_B, queryText: primedB.text });
    expect(postB.hit).toBe(true);
  });

  test('recall path has no lag: a just-inserted fact is listable immediately', async () => {
    const { id } = await engine.insertFact(
      { fact: 'p1 probe: instant recall check', source: 'test:p1' },
      { source_id: SRC_A },
    );
    const rows = await engine.listFactsSince(SRC_A, new Date(0), { activeOnly: true, limit: 50 });
    expect(rows.some((r) => r.id === id)).toBe(true);
  });
});
