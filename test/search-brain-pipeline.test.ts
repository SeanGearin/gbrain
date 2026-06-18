/**
 * search_brain FULL PIPELINE (CC packet 2026-06-18) — Layer 1 + Layer 2 exercised
 * end-to-end through hybridSearch with a DETERMINISTIC embedder, on the CUSTOMER
 * plane (requireLexicalAnchor).
 *
 * The prior tests (and the 5 "green-but-broken" fixes) never ran the vector +
 * facts arms through hybridSearch: PGLite has no embedding provider, so
 * hybridSearch takes the keyword-only early return. Here we install a
 * deterministic TOKEN-OVERLAP embedder via the gateway test seam (cosine ~ shared
 * token fraction — realistic clustering, NOT orthogonal basis vectors), so:
 *   - save_facts embeds facts + materialize embeds chunks (real vectors), and
 *   - hybridSearch embeds the query and runs the chunk-vector arm, the
 *     facts-vector arm, the RRF stub demotion, AND the customer-plane
 *     lexical-anchor gate.
 *
 * This is the harness that would have caught the bug the unit tests miss —
 * including the off-world "pizza" case (CONFIRMED gate blocker in review).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

const SRC = 'tc-sbp';
// Customer/tenant plane: vector + facts arms reinforce keyword-matched entities
// only (the off-world guard). Mirrors what the query op passes on that plane.
const CUSTOMER = { sourceId: SRC, requireLexicalAnchor: true } as const;
let engine: PGLiteEngine;
let DIM = 1536;

/** Deterministic token-overlap embedding: cosine ≈ shared-token fraction. */
function embedText(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  for (const tok of (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
    if (tok.length < 3) continue;
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dims] += 1;
  }
  let norm = 0; for (const x of v) norm += x * x; norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'facts' AND a.attname = 'embedding' AND a.attnum > 0`,
  );
  const m = /vector\((\d+)\)/.exec(rows[0]?.t ?? '');
  DIM = m ? Number(m[1]) : 1536;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests((async ({ values }: any) => ({
    embeddings: (values as string[]).map(t => embedText(t, DIM)),
    usage: { tokens: 0 },
  })) as any);
  if (!isAvailable('embedding')) throw new Error('embedding lane not available — gateway not configured');

  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    [SRC],
  );

  const res = await runSaveFacts(
    [
      // Voltcrest (company) leads → entity_slug companies/voltcrest.
      // "Voltcrest Capital" is a co-mention with NO anchored fact → stays a STUB.
      {
        claim: 'Voltcrest is Robin Hale daily-fantasy and betting startup',
        people: ['Robin Hale'],
        entities: ['Voltcrest', 'Voltcrest Capital'],
        provenance: 'user_stated',
      },
      {
        claim: 'Voltcrest is trying to land its first league partnership and stalled on budget',
        entities: ['Voltcrest'],
        provenance: 'user_stated',
      },
      // A denser, lexically-DISTINCT cluster (4 facts that survive dedup) — must
      // not pollute Voltcrest queries, and Voltcrest must not pollute its queries.
      { claim: 'Glimmerline runs a regional warehouse logistics network for parcel carriers', entities: ['Glimmerline'], provenance: 'user_stated' },
      { claim: 'Glimmerline raised a seed round led by coastal supply-chain investors', entities: ['Glimmerline'], provenance: 'user_stated' },
      { claim: 'Glimmerline hired a fulfillment operations lead for its midwest hubs', entities: ['Glimmerline'], provenance: 'user_stated' },
      { claim: 'Glimmerline signed a multi-year freight contract with a national shipper', entities: ['Glimmerline'], provenance: 'user_stated' },
    ],
    { engine, sourceId: SRC },
  );
  if ('error' in res) throw new Error(`seed failed: ${JSON.stringify(res)}`);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('search_brain full pipeline (customer plane: vector + facts arms + lexical anchor)', () => {
  test('Layer 1 (vector path): a SUBSTANCE query (not the entity name) retrieves the entity', async () => {
    // "league partnership budget" appears only in Voltcrest's FACTS, never the
    // entity name — a hit proves materialized fact substance is reachable through
    // the full fusion (keyword anchors it; vector/facts reinforce).
    const hits = await hybridSearch(engine, 'league partnership budget', CUSTOMER);
    expect(hits.some(h => h.slug === 'companies/voltcrest')).toBe(true);
  });

  test('Layer 2a (stub demotion through real fusion): materialized entity outranks a fact-less stub', async () => {
    const hits = await hybridSearch(engine, 'Voltcrest', CUSTOMER);
    const realIdx = hits.findIndex(h => h.slug === 'companies/voltcrest');
    const stubIdx = hits.findIndex(h => h.slug === 'companies/voltcrest-capital');
    expect(realIdx).toBeGreaterThanOrEqual(0);
    if (stubIdx !== -1) expect(realIdx).toBeLessThan(stubIdx);
    expect(hits[0].chunk_text.includes('Stub page. Created from a saved fact.')).toBe(false);
  });

  test('Layer 2b (entity-correct): a distinct cluster query does NOT pull the other entity', async () => {
    const hits = await hybridSearch(engine, 'Glimmerline warehouse logistics carriers', CUSTOMER);
    expect(hits.some(h => h.slug === 'companies/glimmerline')).toBe(true);
    // Voltcrest's distinctive substance must not bleed into an unrelated query.
    expect(hits.some(h => h.chunk_text.includes('league partnership'))).toBe(false);
  });

  test('OFF-WORLD ("pizza") → empty, NOT a fixed fallback cluster (the gate blocker)', async () => {
    const hits = await hybridSearch(engine, 'pizza margherita napoletana recipe', CUSTOMER);
    // No keyword anchor in this brain → the floorless vector/facts arms must not
    // surface the tight-cluster densest entity. Result tracks the query → empty.
    expect(hits.length).toBe(0);
  });

  test('result set TRACKS the query (different query → different top entity)', async () => {
    const v = await hybridSearch(engine, 'Voltcrest', CUSTOMER);
    const g = await hybridSearch(engine, 'Glimmerline warehouse logistics carriers', CUSTOMER);
    expect(v[0]?.slug).toBe('companies/voltcrest');
    expect(g[0]?.slug).toBe('companies/glimmerline');
  });
});
