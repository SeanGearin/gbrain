/**
 * SR-1 (P0, engine audit 2026-07-17) — query-cache pagination poison.
 *
 * The semantic query cache stored a single PAGE SLICE under an offset-blind
 * key (knobsHash has no offset field). Two deterministic failures followed:
 *
 *   1. False-empty page 2: a page-1 (offset=0) write is HIT by an offset=20
 *      lookup; `hit.results.slice(20, 40)` of a 20-element array is `[]` —
 *      the caller concludes the result set is complete while DB rows exist.
 *   2. Page-1 poison: a fresh offset=N call writes back rows N+1..N+k as the
 *      row's whole result set; the next offset=0 lookup HITS and serves those
 *      rows AS page 1 until TTL.
 *
 * Fix contract (fix/engine-search-honesty):
 *   - Writeback happens ONLY for offset=0 pages (a page-N slice is never
 *     stored), stamped with `meta.cache_window = { limit, complete }`.
 *   - A cache hit serves a window ONLY when it can prove it: either the
 *     stored prefix fully covers [offset, offset+limit), or the row is
 *     marked complete (the search exhausted the pool). Anything else is a
 *     MISS and runs a fresh search at the caller's offset.
 *   - KNOBS_HASH_VERSION bumped so legacy page-slice rows can never serve.
 *
 * Red-first: both scenarios FAIL at the audit sha (5190c7f2) and pass with
 * the fix. Uses the gateway embed-transport test seam (deterministic vectors,
 * no network) against a real PGLite brain + real query_cache.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  hybridSearchCached,
  awaitPendingSearchCacheWrites,
  _resetPendingSearchCacheWritesForTests,
} from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIM = 1536;

/** Deterministic normalized embedding derived from the text. Same text → same vector. */
function vectorFor(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const e = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) e[i] = Math.sin((seed % 1000) * 0.001 + i * 0.01);
  let mag = 0;
  for (let i = 0; i < DIM; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  for (let i = 0; i < DIM; i++) e[i] = e[i] / (mag || 1);
  return e;
}

const PAGE_COUNT = 30;

// Distinct filler words per page so Jaccard dedup never collapses two pages.
function filler(i: number): string {
  return `f${i}alpha f${i}beta f${i}gamma f${i}delta f${i}epsilon f${i}zeta`;
}

async function cacheRowCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM query_cache`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function clearCache(): Promise<void> {
  await engine.executeRaw(`DELETE FROM query_cache`);
  _resetPendingSearchCacheWritesForTests();
}

beforeAll(async () => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({
    embeddings: args.values.map((v) => vectorFor(v)),
  })) as never);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (let i = 1; i <= PAGE_COUNT; i++) {
    const n = String(i).padStart(3, '0');
    const body = `zebrafish study entry variant-b ${n} ${filler(i)}`;
    await engine.putPage(`zp/zp-${n}`, {
      type: 'note',
      title: `Zebra Page ${n}`,
      compiled_truth: body,
    });
    // searchKeyword scans content_chunks, not pages.compiled_truth — seed
    // one chunk per page mirroring the body (same pattern as
    // test/e2e/source-isolation-pglite.test.ts).
    await engine.upsertChunks(`zp/zp-${n}`, [{
      chunk_index: 0,
      chunk_text: body,
      chunk_source: 'compiled_truth',
      token_count: 16,
    }]);
  }
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  try { await engine.disconnect(); } catch { /* ignore */ }
});

const slugsOf = (rs: Array<{ slug: string }>): string[] => rs.map((r) => r.slug);

describe('SR-1 — cache pagination poison', () => {
  test('scenario 1: page 2 after a cached page 1 is NOT false-empty and does not overlap page 1', async () => {
    await clearCache();
    const Q = 'zebrafish study entry';

    // Page 1 — cache miss, fresh search, writes back.
    const page1 = await hybridSearchCached(engine, Q, { limit: 10, offset: 0, expansion: false });
    expect(page1.length).toBe(10);
    await awaitPendingSearchCacheWrites();
    expect(await cacheRowCount()).toBe(1); // the page-1 prefix row exists

    // Page 2 — pre-fix this HITS the offset-blind row and slices past its end → [].
    const page2 = await hybridSearchCached(engine, Q, { limit: 10, offset: 10, expansion: false });
    expect(page2.length).toBeGreaterThan(0); // RED pre-fix: [] while 30 matching pages exist

    // No overlap: page 2 is the next window of the same ordering, not a re-serve.
    const s1 = new Set(slugsOf(page1));
    for (const s of slugsOf(page2)) expect(s1.has(s)).toBe(false);
  }, 60_000);

  test('scenario 2: a fresh offset>0 call must not poison page 1', async () => {
    await clearCache();
    const Q = 'zebrafish study entry variant-b';

    // Ground truth for page 1, bypassing the cache entirely.
    const truth1 = await hybridSearchCached(engine, Q, { limit: 10, offset: 0, expansion: false, useCache: false });
    expect(truth1.length).toBe(10);
    await clearCache();

    // First-ever CACHED call for Q at offset=10. Pre-fix, its slice is written
    // back as the row's whole result set.
    const deep = await hybridSearchCached(engine, Q, { limit: 10, offset: 10, expansion: false });
    expect(deep.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    // Post-fix contract: page-N slices are never stored.
    expect(await cacheRowCount()).toBe(0); // RED pre-fix: 1 (the poison row)

    // Page 1 must equal ground truth. Pre-fix it serves rows 11-20 AS page 1.
    const page1 = await hybridSearchCached(engine, Q, { limit: 10, offset: 0, expansion: false });
    expect(slugsOf(page1)).toEqual(slugsOf(truth1)); // RED pre-fix
  }, 60_000);

  // NOT a red-first defect proof (pre-fix served [] here too, by accident of
  // the offset-blind slice) — this is the DESIGN GUARD for the fix: a row
  // marked complete may honestly serve an empty deep page from cache instead
  // of degrading every deep request into a fresh search.
  test('scenario 3 (design guard): complete rows honestly serve an empty deep page from cache', async () => {
    await clearCache();
    // Only one page contains this term → pool exhausts below the limit →
    // the writeback marks the row complete → a deep page is a PROVABLE [].
    const Q = 'f7gamma';
    const page1 = await hybridSearchCached(engine, Q, { limit: 10, offset: 0, expansion: false });
    expect(page1.length).toBeGreaterThan(0);
    expect(page1.length).toBeLessThan(10);
    await awaitPendingSearchCacheWrites();
    expect(await cacheRowCount()).toBe(1);

    // Deep page: served from the complete cached row as an honest empty
    // (no fresh search needed — the cache can PROVE the set ended).
    let meta: { cache?: { status: string } } | undefined;
    const deep = await hybridSearchCached(engine, Q, {
      limit: 10, offset: 20, expansion: false,
      onMeta: (m) => { meta = m as typeof meta; },
    });
    expect(deep.length).toBe(0);
    expect(meta?.cache?.status).toBe('hit');
  }, 60_000);
});
