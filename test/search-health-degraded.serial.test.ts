/**
 * SR-6 (engine audit 2026-07-17) — degraded-mode dishonesty.
 *
 * At the audit sha (5190c7f2) an embed/vector-arm failure was swallowed into
 * keyword-only results and the degradation flag (meta.vector_enabled=false)
 * never reached the response: a degraded tenant search returning [] was
 * byte-identical to a true no-match. The system KNEW and did not say.
 *
 * Fix contract (fix/engine-search-honesty): the search + query ops return
 *
 *   { results: SearchResult[], search_health: {
 *       degraded: boolean,       // an arm that should have run FAILED — the
 *                                // set may be missing semantic matches
 *       vector_enabled: boolean, // the vector arm actually ran
 *       mode: 'hybrid' | 'keyword_only' | 'image_vector',
 *       reason?: string          // machine-readable cause when degraded
 *   } }
 *
 * degraded=false + vector_enabled=false means the brain is CONFIGURED
 * keyword-only (no provider / operator opt-out) — expected mode, not a
 * failure. degraded=true means the engine cannot prove completeness for this
 * response and the caller must not present "no results" as a verified
 * no-match.
 *
 * Red-first: RED-tagged assertions fail at the audit sha (bare-array shape,
 * no health signal). Uses the gateway embed-transport seam to force provider
 * failure deterministically.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIM = 1536;
let embedShouldFail = true;

beforeAll(async () => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    if (embedShouldFail) throw new Error('embedding provider down (simulated outage)');
    return {
      embeddings: args.values.map(() => Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.01))),
    };
  }) as never);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('wl/walrus-01', {
    type: 'note',
    title: 'Walrus Observation',
    compiled_truth: 'walrus colony observed near the northern shore',
  });
  // searchKeyword scans content_chunks — seed one chunk mirroring the body.
  await engine.upsertChunks('wl/walrus-01', [{
    chunk_index: 0,
    chunk_text: 'walrus colony observed near the northern shore',
    chunk_source: 'compiled_truth',
    token_count: 10,
  }]);
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  try { await engine.disconnect(); } catch { /* ignore */ }
});

const ctx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);

type SearchEnvelope = {
  results: Array<{ slug: string }>;
  search_health: {
    degraded: boolean;
    vector_enabled: boolean;
    mode?: string;
    reason?: string;
  };
};

describe('SR-6 — the degradation flag reaches the response', () => {
  test('embed failure + keyword matches: results flow AND degraded=true', async () => {
    embedShouldFail = true;
    const search = operationsByName['search'];
    const res = (await search.handler(ctx(), { query: 'walrus colony', limit: 5 })) as SearchEnvelope;
    expect(Array.isArray(res.results)).toBe(true);       // RED pre-fix: bare array, no envelope
    expect(res.results.length).toBeGreaterThan(0);       // keyword arm still found it
    expect(res.search_health.degraded).toBe(true);       // RED pre-fix: no health signal at all
    expect(res.search_health.vector_enabled).toBe(false);
    expect(typeof res.search_health.reason).toBe('string');
  }, 60_000);

  test('THE dishonesty case: degraded + empty is distinguishable from a true no-match', async () => {
    embedShouldFail = true;
    const search = operationsByName['search'];
    const res = (await search.handler(ctx(), { query: 'xylophone quartet', limit: 5 })) as SearchEnvelope;
    expect(res.results.length).toBe(0);
    // Pre-fix this response was byte-identical to a healthy no-match ([]).
    expect(res.search_health.degraded).toBe(true);       // RED pre-fix
  }, 60_000);

  test('healthy pipeline: degraded=false, vector_enabled=true', async () => {
    embedShouldFail = false;
    const search = operationsByName['search'];
    const res = (await search.handler(ctx(), { query: 'walrus colony', limit: 5, offset: 0 })) as SearchEnvelope;
    expect(res.search_health.degraded).toBe(false);
    expect(res.search_health.vector_enabled).toBe(true);
    expect(res.search_health.reason).toBeUndefined();
  }, 60_000);

  test('query op carries the same envelope', async () => {
    embedShouldFail = true;
    const query = operationsByName['query'];
    const res = (await query.handler(ctx(), { query: 'walrus colony', limit: 5, expand: false })) as SearchEnvelope;
    expect(Array.isArray(res.results)).toBe(true);       // RED pre-fix
    expect(res.search_health.degraded).toBe(true);
  }, 60_000);

  test('no provider configured is NOT degraded (expected keyword mode)', async () => {
    embedShouldFail = true;
    __setEmbedTransportForTests(null);
    resetGateway(); // no gateway config at all → isAvailable('embedding') false
    try {
      const search = operationsByName['search'];
      const res = (await search.handler(ctx(), { query: 'walrus colony', limit: 5 })) as SearchEnvelope;
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.search_health.degraded).toBe(false);    // configured mode, not a failure
      expect(res.search_health.vector_enabled).toBe(false);
    } finally {
      // Restore the transport + config for any later test in this file.
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: DIM,
        env: { OPENAI_API_KEY: 'sk-fake' },
      });
      __setEmbedTransportForTests((async (args: { values: string[] }) => {
        if (embedShouldFail) throw new Error('embedding provider down (simulated outage)');
        return {
          embeddings: args.values.map(() => Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.01))),
        };
      }) as never);
    }
  }, 60_000);
});
