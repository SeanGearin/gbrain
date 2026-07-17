import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { SearchResult, SearchOpts } from '../src/core/types.ts';

// C1 (engine verify 2026-07-16, fixed 2026-07-17): the lexical-anchor
// per-term probe must reach a query's entity term REGARDLESS of where it
// sits in the query. The pre-fix probe took the FIRST 6 significant terms
// in query order, so a compound question front-loaded with >=6 significant
// out-of-corpus terms before the entity name exhausted the cap, the entity
// was never probed, and the anchor gate annihilated every fused hit —
// while the entity sub-question alone returned results. Asserted here on
// the raw-fallback leg (no decomposition), the exact shape the compound
// parity suite leaves uncovered. The off-world guard the gate exists for
// (a query with NO in-corpus term gates to empty even when the vector arm
// surfaces the dense cluster) is pinned alongside so the fix can never
// trade it away.

const DIMS = 8;

function normalized(values: number[]): Float32Array {
  const out = new Float32Array(DIMS);
  for (let i = 0; i < Math.min(values.length, DIMS); i++) out[i] = values[i];
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < out.length; i++) out[i] /= mag;
  return out;
}

// zembed-style tight cluster: an off-world entity ("Boltline") embeds in
// the SAME direction as real pages — the vector arm cannot tell it apart,
// which is exactly why the lexical gate has to.
function embeddingFor(query: string): Float32Array {
  const q = query.toLowerCase();
  if (q.includes('funding')) return normalized([2, 1]);
  if (q.includes('sightline')) return normalized([1, 1]);
  if (q.includes('boltline')) return normalized([1, 1]);
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

function makeFakeEngine(args: {
  probed: string[];
  vectorHits: SearchResult[][];
  keyword: (query: string, opts: SearchOpts) => SearchResult[];
  vector: (embedding: Float32Array, opts: SearchOpts) => SearchResult[];
}) {
  return {
    getConfig: async () => null,
    searchKeyword: async (query: string, opts: SearchOpts) => {
      args.probed.push(query);
      return args.keyword(query, opts);
    },
    searchVector: async (embedding: Float32Array, opts: SearchOpts) => {
      const hits = args.vector(embedding, opts);
      args.vectorHits.push(hits);
      return hits;
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

// Same realistic tenant corpus shape as the compound parity suite: whole
// conversational phrases FTS-AND to nothing; the entity term hits.
function corpusKeyword(query: string): SearchResult[] {
  const q = query.toLowerCase().trim();
  if (q === 'sightline') return [profile];
  if (q === 'funding') return [funding];
  return [];
}

function corpusVector(embedding: Float32Array): SearchResult[] {
  if (embedding[0] > 0.85) return [funding, profile];
  if (embedding[0] > 0.6) return [profile, funding];
  return [];
}

function tenantEngine() {
  const probed: string[] = [];
  const vectorHits: SearchResult[][] = [];
  const engine = makeFakeEngine({ probed, vectorHits, keyword: corpusKeyword, vector: corpusVector });
  return { engine, probed, vectorHits };
}

const TENANT_OPTS = {
  mode: 'conservative' as const,
  limit: 10,
  requireLexicalAnchor: true,
};

// 6 significant out-of-corpus terms (give, best, comprehensive, holistic,
// strategic, overall) precede the entity term; me/your are filler. This is
// the live-receipted C1 shape: pre-fix the probe tested exactly those 6
// and never "sightline".
const FRONTLOADED =
  'give me your best comprehensive holistic strategic overall assessment regarding Sightline';

// 13 significant junk terms before the entity, no capitalization anywhere —
// overflows even the raised cap, and offers no entity-case signal. Only
// position-independent overflow selection can reach the trailing entity.
const FRONTLOADED_LONG =
  'give me your best comprehensive holistic strategic overall detailed thorough ' +
  'exhaustive complete rigorous careful systematic assessment regarding sightline';

// Same wordy shape, entity NOT in the corpus: the gate's reason to exist.
const OFF_WORLD =
  'give me your best comprehensive holistic strategic overall assessment regarding Boltline';

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

describe('anchor-probe front-loaded compound (tenant plane)', () => {
  test('entity sub-question alone returns hits (harness sanity)', async () => {
    const { engine } = tenantEngine();
    const out = await hybridSearch(engine, 'Sightline', { ...TENANT_OPTS });
    expect(out.map((r) => r.slug)).toContain('companies/sightline');
  });

  test('front-loaded compound without decomposition still reaches the entity term', async () => {
    const { engine, probed } = tenantEngine();
    const out = await hybridSearch(engine, FRONTLOADED, { ...TENANT_OPTS });
    // The probe must have tested the entity term itself…
    expect(probed).toContain('sightline');
    // …and the anchored entity page survives the gate.
    expect(out.map((r) => r.slug)).toContain('companies/sightline');
    // The gate still drops fused slugs with NO lexical evidence in this ask.
    expect(out.map((r) => r.slug)).not.toContain('deals/sightline-funding');
  });

  test('all-lowercase variant (no entity-case signal) also reaches the entity', async () => {
    const { engine } = tenantEngine();
    const out = await hybridSearch(engine, FRONTLOADED.toLowerCase(), { ...TENANT_OPTS });
    expect(out.map((r) => r.slug)).toContain('companies/sightline');
  });

  test('over-cap junk run before a trailing lowercase entity still gets it probed', async () => {
    const { engine, probed } = tenantEngine();
    const out = await hybridSearch(engine, FRONTLOADED_LONG, { ...TENANT_OPTS });
    expect(probed).toContain('sightline');
    expect(out.map((r) => r.slug)).toContain('companies/sightline');
  });

  test('true off-world query still gates to empty even when the vector arm fires', async () => {
    const { engine, vectorHits } = tenantEngine();
    const out = await hybridSearch(engine, OFF_WORLD, { ...TENANT_OPTS });
    // Non-vacuous: the vector arm DID surface the dense cluster…
    expect(vectorHits.some((hits) => hits.length > 0)).toBe(true);
    // …and the gate annihilated it, because no term has lexical evidence.
    expect(out).toHaveLength(0);
  });
});
