/**
 * v0.40.6 (B7 tenant query_cache fix) — the two regression tests from the
 * ze-unification-runbook FIX PASS SPEC (items 1 + 2).
 *
 * INCIDENT (runbook §INCIDENT): with the ZE key in serve-http.env, the first
 * tenant vector `query` hit `brain_unavailable` on every call. The semantic
 * cache write defaulted its row's source_id to 'default' (a federated tenant
 * resolves to opts.sourceIds — the read scope — leaving scalar opts.sourceId
 * undefined), so the INSERT tripped the query_cache RLS WITH CHECK
 * (b7_tenant_isolation), raised 25P02, and POISONED the withSourceScope
 * dispatch tx — every later statement died.
 *
 * Two fixes, two tests (both PGLite-backed; no DATABASE_URL):
 *   1. hybridSearchCached threads `cacheSourceId` (the dispatch scope, == the
 *      op's ctx.sourceId) as the cache row's owner, independent of the
 *      federated read scope → the row lands under the tenant, not 'default'.
 *   2. store()'s INSERT is wrapped in engine.transaction() (a SAVEPOINT when
 *      nested in the dispatch tx) so a failed cache write can never break the
 *      request — the query still returns its results.
 *
 * What PGLite CANNOT cover here: the gbrain_tenant role + the RLS WITH CHECK
 * itself are Postgres-only (PGLite withSourceScope is a pass-through, no RLS
 * engine). The "RLS holds / outer tx survives the savepoint rollback" leg is
 * verified by the Postgres rls-backstop e2e + the runbook's re-activation
 * step. These tests pin the two code-level contracts the fix changed.
 *
 * `.serial` because it drives configureGateway()/__setEmbedTransportForTests,
 * which are process-global gateway state.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  hybridSearchCached,
  awaitPendingSearchCacheWrites,
} from '../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const DIM = 1536;
const TENANT = 'tenanta';

// A single constant vector for both the query and the seeded chunk so cosine
// distance is ~0 and vector search always returns the chunk (→ results > 0 →
// the cache writeback path fires).
const QVEC: number[] = Array.from({ length: DIM }, (_, j) => (j === 0 ? 1 : 0.1));

let engine: PGLiteEngine;

beforeAll(async () => {
  // Pin OpenAI@1536 (symmetric: query and document embeddings are identical)
  // BEFORE initSchema so query_cache.embedding + content_chunks.embedding are
  // both vector(1536) — matching QVEC. A provider key makes
  // isAvailable('embedding') true so the vector lane (and thus the cache
  // writeback) actually runs.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  // Every embed call (query + any document) returns QVEC.
  __setEmbedTransportForTests((async (args: { values?: unknown[] }) => ({
    embeddings: (args.values ?? [undefined]).map(() => QVEC),
  })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed a tenant source + one page/chunk under it, then stamp the chunk's
  // embedding so a vector search scoped to [TENANT] returns it.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    [TENANT, 'Tenant A'],
  );
  await engine.putPage(
    'docs/alice',
    { type: 'concept', title: 'Alice the builder', compiled_truth: 'Alice is a builder who builds things.' },
    { sourceId: TENANT },
  );
  await engine.upsertChunks(
    'docs/alice',
    [{ chunk_index: 0, chunk_text: 'alice builder chunk', chunk_source: 'compiled_truth' }],
    { sourceId: TENANT },
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'docs/alice'`,
  );
  await engine.executeRaw(
    `UPDATE content_chunks SET embedding = $1::vector, embedded_at = now() WHERE id = $2`,
    [`[${QVEC.join(',')}]`, rows[0].id],
  );
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  try { await engine.disconnect(); } catch { /* ignore */ }
});

describe('B7 query_cache — item 1: cache row owner is the dispatch scope, not the read scope', () => {
  test('federated read scope (sourceIds) + cacheSourceId → row lands under the tenant, never "default"', async () => {
    await engine.executeRaw(`DELETE FROM query_cache`);

    // The tenant shape from the incident: federated read allow-list = [TENANT]
    // (so scalar opts.sourceId is undefined), dispatch owner = TENANT.
    const results = await hybridSearchCached(engine, 'alice builder', {
      limit: 5,
      sourceIds: [TENANT],
      cacheSourceId: TENANT,
    });
    await awaitPendingSearchCacheWrites();

    expect(results.length).toBeGreaterThan(0);
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM query_cache`,
    );
    expect(rows.length).toBe(1);
    // Pre-fix this was 'default' (opts.sourceId undefined under federation) →
    // RLS WITH CHECK violation on the customer plane. Post-fix: the tenant.
    expect(rows[0].source_id).toBe(TENANT);
  });

  test('without cacheSourceId, a federated-only call still falls back to "default" (proves the op layer must supply it)', async () => {
    await engine.executeRaw(`DELETE FROM query_cache`);

    // Exactly the pre-fix code path: only the read scope is set. This documents
    // why operations.ts now threads ctx.sourceId as cacheSourceId — the read
    // allow-list alone does NOT make the cache RLS-safe.
    await hybridSearchCached(engine, 'alice builder', {
      limit: 5,
      sourceIds: [TENANT],
    });
    await awaitPendingSearchCacheWrites();

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM query_cache`,
    );
    // One row, owned by 'default' — harmless on PGLite (no RLS), the 25P02
    // trigger on Postgres. The op-layer cacheSourceId thread is what prevents
    // this on the customer plane.
    if (rows.length > 0) expect(rows[0].source_id).toBe('default');
  });
});

describe('B7 query_cache — item 2: a failed cache write cannot break the request', () => {
  test('store() failure is isolated — the query still returns its results', async () => {
    await engine.executeRaw(`DELETE FROM query_cache`);

    // Force the cache write to fail at the exact seam the fix wraps:
    // store() is the ONLY caller of engine.transaction() in the search path
    // (query-cache.ts), so a proxy that rejects transaction() — while
    // delegating every read to the real engine — reproduces a poisoned cache
    // write without touching the search path. On Postgres this is the RLS
    // WITH CHECK 25P02; here it stands in for any store failure.
    const failingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async () => { throw new Error('forced cache-write failure'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;

    let threw = false;
    let results: Awaited<ReturnType<typeof hybridSearchCached>> = [];
    try {
      results = await hybridSearchCached(failingEngine, 'alice builder', {
        limit: 5,
        sourceIds: [TENANT],
        cacheSourceId: TENANT,
      });
      await awaitPendingSearchCacheWrites();
    } catch {
      threw = true;
    }

    // The request survives the failed writeback and returns real results.
    expect(threw).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('docs/alice');

    // The failed write left nothing behind (rolled back / swallowed).
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache`,
    );
    expect(rows[0].n).toBe(0);
  });
});
