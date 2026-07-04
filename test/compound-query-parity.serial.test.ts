import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { SearchResult, SearchOpts } from '../src/core/types.ts';

// Acceptance invariant for the compound-query fix (F1, live-verified empty
// 2026-07-01 on the Marcus tenant): a compound / multi-intent question NEVER
// returns worse results than its best sub-question, and when decomposition
// yields nothing the raw query still runs as a single search. Both asserted
// under the tenant-plane shape (requireLexicalAnchor: true) where the
// pre-fix whole-phrase anchor gate hard-emptied compound questions.

const DIMS = 8;

function normalized(values: number[]): Float32Array {
  const out = new Float32Array(DIMS);
  for (let i = 0; i < Math.min(values.length, DIMS); i++) out[i] = values[i];
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= mag;
  }
  return out;
}

function embeddingFor(query: string): Float32Array {
  const q = query.toLowerCase();
  if (q.includes('funding')) return normalized([2, 1]);
  if (q.includes('sightline')) return normalized([1, 1]);
  return normalized([0, 1]);
}

function result(slug: string, chunkId: number): SearchResult {
  return {
    slug,
    page_id: chunkId,
    title: slug,
    type: 'company',
    chunk_text: `strong match for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: chunkId,
    chunk_index: 0,
    score: 1,
    stale: false,
  };
}

const profile = result('companies/sightline', 40);
const funding = result('deals/sightline-funding', 41);

interface FakeSearchCall {
  kind: 'keyword' | 'vector';
  query?: string;
}

function makeFakeEngine(args: {
  calls: FakeSearchCall[];
  keyword: (query: string, opts: SearchOpts) => SearchResult[];
  vector: (embedding: Float32Array, opts: SearchOpts) => SearchResult[];
}) {
  return {
    getConfig: async () => null,
    searchKeyword: async (query: string, opts: SearchOpts) => {
      args.calls.push({ kind: 'keyword', query });
      return args.keyword(query, opts);
    },
    searchVector: async (embedding: Float32Array, opts: SearchOpts) => {
      args.calls.push({ kind: 'vector' });
      return args.vector(embedding, opts);
    },
    searchFactsVector: async () => [],
    getEmbeddingsByChunkIds: async () => new Map(),
    getBacklinkCounts: async () => new Map(),
    getSalienceScores: async () => new Map(),
    getEffectiveDates: async () => new Map(),
    getContentFlagsByPageIds: async () => new Map(),
    resolveAliases: async () => new Map(),
    executeRaw: async () => [],
  } as any;
}

// The realistic tenant corpus shape: whole conversational phrases FTS-AND to
// nothing; the entity/topic terms and the crisp sub-question phrasings hit.
function corpusKeyword(query: string): SearchResult[] {
  const q = query.toLowerCase().trim();
  if (q === 'sightline company profile') return [profile];
  if (q === 'sightline funding situation') return [funding];
  if (q === 'sightline') return [profile];
  if (q === 'funding') return [funding];
  return []; // compound phrase, filler terms: no whole-phrase FTS match
}

function corpusVector(embedding: Float32Array): SearchResult[] {
  // funding-flavored embeddings rank the deal page first; entity-flavored
  // rank the profile first; everything in the tight cluster sees both.
  if (embedding[0] > 0.85) return [funding, profile];
  if (embedding[0] > 0.6) return [profile, funding];
  return [];
}

const TENANT_OPTS = {
  mode: 'conservative' as const,
  limit: 10,
  requireLexicalAnchor: true,
};

const COMPOUND = 'tell me about Sightline and its funding situation';
const SUB_QUESTIONS = ['Sightline company profile', 'Sightline funding situation'];

beforeEach(() => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: (values as string[]).map(embeddingFor),
    usage: { tokens: 0 },
  }) as any);
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('compound-query parity (tenant plane)', () => {
  test('compound question returns a superset of every sub-question run alone', async () => {
    // Baseline: each sub-question alone, tenant shape, no expansion.
    const subResultSets: Set<string>[] = [];
    for (const sub of SUB_QUESTIONS) {
      const engine = makeFakeEngine({ calls: [], keyword: corpusKeyword, vector: corpusVector });
      const out = await hybridSearch(engine, sub, { ...TENANT_OPTS });
      subResultSets.push(new Set(out.map((r) => r.slug)));
    }
    // Sanity: the sub-questions individually hit (the live-verified shape).
    expect(subResultSets.every((s) => s.size > 0)).toBe(true);

    // Compound question with decomposition into those sub-questions.
    const engine = makeFakeEngine({ calls: [], keyword: corpusKeyword, vector: corpusVector });
    const out = await hybridSearch(engine, COMPOUND, {
      ...TENANT_OPTS,
      expansion: true,
      expandFn: async () => [COMPOUND, ...SUB_QUESTIONS],
    });
    const compoundSlugs = new Set(out.map((r) => r.slug));

    // THE invariant: never worse than the best sub-question — asserted as
    // strictly stronger: superset of EVERY sub-question's results.
    for (const subSet of subResultSets) {
      for (const slug of subSet) {
        expect(compoundSlugs.has(slug)).toBe(true);
      }
    }
  });

  test('decomposition yielding nothing falls back to the raw query as a single search', async () => {
    // Raw-query baseline (no expansion at all).
    const baselineEngine = makeFakeEngine({ calls: [], keyword: corpusKeyword, vector: corpusVector });
    const baseline = await hybridSearch(baselineEngine, 'Sightline funding situation', { ...TENANT_OPTS });
    expect(baseline.length).toBeGreaterThan(0);

    // Same query, expansion requested but the decomposer returns NOTHING.
    const engine = makeFakeEngine({ calls: [], keyword: corpusKeyword, vector: corpusVector });
    const out = await hybridSearch(engine, 'Sightline funding situation', {
      ...TENANT_OPTS,
      expansion: true,
      expandFn: async () => [],
    });

    expect(out.map((r) => r.slug)).toEqual(baseline.map((r) => r.slug));
  });

  test('decomposition throwing falls back to the raw query, never to empty', async () => {
    const engine = makeFakeEngine({ calls: [], keyword: corpusKeyword, vector: corpusVector });
    const out = await hybridSearch(engine, 'Sightline funding situation', {
      ...TENANT_OPTS,
      expansion: true,
      expandFn: async () => {
        throw new Error('decomposition gateway down');
      },
    });

    expect(out.length).toBeGreaterThan(0);
    expect(out.map((r) => r.slug)).toContain('deals/sightline-funding');
  });
});
