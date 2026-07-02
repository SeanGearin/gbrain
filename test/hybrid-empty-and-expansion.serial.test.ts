import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { SearchResult, SearchOpts } from '../src/core/types.ts';

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
  if (q.includes('boltline')) return normalized([3, 1]);
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

interface FakeSearchCall {
  kind: 'keyword' | 'vector';
  query?: string;
  detail?: SearchOpts['detail'];
}

function makeFakeEngine(args: {
  calls: FakeSearchCall[];
  keyword: (query: string, opts: SearchOpts) => SearchResult[];
  vector: (embedding: Float32Array, opts: SearchOpts) => SearchResult[];
}) {
  return {
    getConfig: async () => null,
    searchKeyword: async (query: string, opts: SearchOpts) => {
      args.calls.push({ kind: 'keyword', query, detail: opts.detail });
      return args.keyword(query, opts);
    },
    searchVector: async (embedding: Float32Array, opts: SearchOpts) => {
      args.calls.push({ kind: 'vector', detail: opts.detail });
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

describe('hybridSearch empty-result escalation', () => {
  test('resolved-low empty results (ENTITY intent auto-detail) retry once with high detail', async () => {
    const calls: FakeSearchCall[] = [];
    const engine = makeFakeEngine({
      calls,
      keyword: () => [],
      vector: (_embedding, opts) => opts.detail === 'high'
        ? [result('companies/boltline', 1)]
        : [],
    });

    // "what do I know about X" auto-detects detail 'low' via ENTITY intent —
    // the F1 shape. Only resolved-low passes may escalate: 'low' is the one
    // level that narrows the searched chunk set, so the retry can rescue.
    const out = await hybridSearch(engine, 'what do I know about Boltline', {
      mode: 'conservative',
      limit: 5,
    });

    expect(out.map((r) => r.slug)).toEqual(['companies/boltline']);
    expect(calls.filter((c) => c.kind === 'vector').map((c) => c.detail)).toEqual(['low', 'high']);
  });

  test('default-detail (GENERAL intent) empty results do NOT retry — same candidate pool, futile', async () => {
    const calls: FakeSearchCall[] = [];
    const engine = makeFakeEngine({
      calls,
      keyword: () => [],
      vector: () => [],
    });

    const out = await hybridSearch(engine, 'Boltline traction memo', {
      mode: 'conservative',
      limit: 5,
    });

    expect(out).toEqual([]);
    expect(calls.filter((c) => c.kind === 'vector').map((c) => c.detail)).toEqual([undefined]);
  });

  test('escalation happens at most once (recursion guard)', async () => {
    const calls: FakeSearchCall[] = [];
    const engine = makeFakeEngine({
      calls,
      keyword: () => [],
      vector: () => [],
    });

    const out = await hybridSearch(engine, 'who is glorbax the unfindable', {
      mode: 'conservative',
      limit: 5,
    });

    expect(out).toEqual([]);
    expect(calls.filter((c) => c.kind === 'vector').map((c) => c.detail)).toEqual(['low', 'high']);
  });
});

describe('lexical-anchor term probe', () => {
  test('conversational phrase about a real entity survives the gate via per-term anchors', async () => {
    const calls: FakeSearchCall[] = [];
    const boltline = result('companies/boltline', 20);
    const engine = makeFakeEngine({
      calls,
      // Whole phrase misses (FTS AND: "know" is out-of-corpus); the bare
      // entity term hits — the probe must find it and anchor the vector hit.
      keyword: (query) => (query.toLowerCase() === 'boltline' ? [boltline] : []),
      vector: () => [boltline],
    });

    const out = await hybridSearch(engine, 'what do you know about Boltline', {
      mode: 'conservative',
      limit: 5,
      requireLexicalAnchor: true,
    });

    expect(out.map((r) => r.slug)).toEqual(['companies/boltline']);
    const keywordQueries = calls.filter((c) => c.kind === 'keyword').map((c) => c.query?.toLowerCase());
    expect(keywordQueries).toContain('boltline');
  });

  test('a single spurious whole-phrase anchor no longer throttles recall (anchors are unioned)', async () => {
    const calls: FakeSearchCall[] = [];
    const insight = result('devon-pryor', 30);
    const sightline = result('companies/sightline', 31);
    const engine = makeFakeEngine({
      calls,
      // The full phrase matches ONLY the insight page (the one doc containing
      // every term); the entity term matches the entity page.
      keyword: (query) => {
        const q = query.toLowerCase();
        if (q === 'tell me about sightline and its funding situation') return [insight];
        if (q === 'sightline') return [sightline];
        return [];
      },
      vector: () => [sightline, insight],
    });

    const out = await hybridSearch(engine, 'tell me about Sightline and its funding situation', {
      mode: 'conservative',
      limit: 5,
      requireLexicalAnchor: true,
    });

    expect(new Set(out.map((r) => r.slug))).toEqual(new Set(['companies/sightline', 'devon-pryor']));
  });

  test('true off-world query still gates to empty (no term anchors anywhere)', async () => {
    const calls: FakeSearchCall[] = [];
    const engine = makeFakeEngine({
      calls,
      keyword: () => [],
      // Vector always returns something (zembed packs everything close) —
      // exactly the junk the gate exists to suppress.
      vector: () => [result('companies/boltline', 21)],
    });

    const out = await hybridSearch(engine, 'purple elephant quantum tariffs', {
      mode: 'conservative',
      limit: 5,
      requireLexicalAnchor: true,
    });

    expect(out).toEqual([]);
  });
});

describe('hybridSearch expansion + lexical anchor', () => {
  test('expanded sub-query hits are not erased by the tenant lexical-anchor gate', async () => {
    const calls: FakeSearchCall[] = [];
    const profile = result('companies/sightline', 10);
    const funding = result('deals/sightline-funding', 11);
    const engine = makeFakeEngine({
      calls,
      keyword: (query) => {
        const q = query.toLowerCase();
        if (q === 'sightline company profile') return [profile];
        if (q === 'sightline funding situation') return [funding];
        return [];
      },
      vector: (embedding) => {
        if (embedding[0] > 0.85) return [funding];
        if (embedding[0] > 0.6) return [profile];
        return [];
      },
    });

    const out = await hybridSearch(engine, 'tell me about Sightline and its funding situation', {
      mode: 'conservative',
      limit: 5,
      expansion: true,
      requireLexicalAnchor: true,
      expandFn: async () => [
        'tell me about Sightline and its funding situation',
        'Sightline company profile',
        'Sightline funding situation',
      ],
    });

    expect(out.map((r) => r.slug).sort()).toEqual([
      'companies/sightline',
      'deals/sightline-funding',
    ]);
    // The three phrase arms run first; per-term anchor probes may follow.
    expect(calls.filter((c) => c.kind === 'keyword').map((c) => c.query).slice(0, 3)).toEqual([
      'tell me about Sightline and its funding situation',
      'Sightline company profile',
      'Sightline funding situation',
    ]);
  });
});
