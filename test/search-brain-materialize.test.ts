/**
 * search_brain materialize + ranking (CC packet 2026-06-18).
 *
 * These tests target the EXACT failure the two prior "green but broken" attempts
 * (06e93018 stub-chunking, 61b1c436 facts-vector arm) missed:
 *   - prior construct test searched for the entity NAME (which the stub already
 *     carries) — never for fact SUBSTANCE, so the stub-chunk-only body passed;
 *   - prior facts-vector test used orthogonal basis vectors — so the wrong-entity
 *     collision and the stub-vs-fact ranking battle never happened.
 *
 * So here we assert SUBSTANCE retrieval (Layer 1) and the stub-vs-real ranking +
 * facts-arm entity gate (Layer 2) directly. PGLite, no provider keys: save_facts
 * lands NULL-embedding chunks (the deterministic intake), and the chunk
 * search_vector trigger makes fact substance keyword-searchable immediately —
 * which is the arm we assert. Ranking + gating are exercised through the pure,
 * exported fusion/gate helpers so no live embedder is needed.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import {
  compileEntityBody,
  materializeEntityPages,
  STUB_MARKER,
} from '../src/core/facts/construct.ts';
import {
  hybridSearch,
  rrfFusionWeighted,
  rrfFusion,
  gateFactsToMatchedEntities,
} from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;
const SRC = 'tc-sbm';

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

// ---------------------------------------------------------------------------
// A. compileEntityBody — pure deterministic facts → markdown
// ---------------------------------------------------------------------------
describe('compileEntityBody', () => {
  test('no facts → stub skeleton (carries the stub marker)', () => {
    const body = compileEntityBody('Voltcrest', 'company', []);
    expect(body).toContain('# Voltcrest');
    expect(body).toContain('**Type:** Company');
    expect(body).toContain(STUB_MARKER);
    expect(body).not.toContain('## Facts');
  });

  test('with facts → ## Facts list of fact substance, NO stub marker', () => {
    const body = compileEntityBody('Voltcrest', 'company', [
      { fact: 'Voltcrest is a daily-fantasy and betting startup' },
      { fact: 'Voltcrest is trying to land its first league partnership' },
    ]);
    expect(body).toContain('# Voltcrest');
    expect(body).toContain('## Facts');
    expect(body).toContain('- Voltcrest is a daily-fantasy and betting startup');
    expect(body).toContain('- Voltcrest is trying to land its first league partnership');
    // Critically: it is no longer a stub.
    expect(body).not.toContain(STUB_MARKER);
  });

  test('dedups identical fact text and renders oldest-first (append-stable)', () => {
    // listFactsByEntity returns newest-first; compile renders oldest-first so a
    // later fact appends BELOW earlier ones (stable body across re-materialize).
    const body = compileEntityBody('Voltcrest', 'company', [
      { fact: 'newer fact' }, // newest first (as listFactsByEntity returns)
      { fact: 'older fact' },
      { fact: 'older fact' }, // duplicate — dropped
    ]);
    const lines = body.split('\n').filter(l => l.startsWith('- '));
    expect(lines).toEqual(['- older fact', '- newer fact']);
  });

  test('person type label', () => {
    const body = compileEntityBody('Robin Hale', 'person', [{ fact: 'Robin Hale founded Voltcrest' }]);
    expect(body).toContain('**Type:** Person');
  });
});

// ---------------------------------------------------------------------------
// B. End-to-end: save_facts → materialized body + fact-SUBSTANCE searchability
//    (the bug the prior tests missed)
// ---------------------------------------------------------------------------
describe('save_facts materializes entity bodies (Layer 1)', () => {
  beforeAll(async () => {
    const res = await runSaveFacts(
      [
        // leading mention = Voltcrest (company) → entity_slug companies/voltcrest
        {
          claim: "Voltcrest is Robin Hale's daily-fantasy and betting startup",
          people: ['Robin Hale'],
          entities: ['Voltcrest'],
          provenance: 'user_stated',
        },
        // second Voltcrest fact, same entity
        {
          claim: 'Voltcrest is trying to land its first league partnership and stalled on budget',
          entities: ['Voltcrest'],
          provenance: 'user_stated',
        },
        // leading mention = Robin Hale (person) → entity_slug people/robin-hale
        {
          claim: 'Robin Hale founded Voltcrest after leaving a hedge fund',
          people: ['Robin Hale'],
          entities: ['Voltcrest'],
          provenance: 'user_stated',
        },
      ],
      { engine, sourceId: SRC },
    );
    if ('error' in res) throw new Error(`seed failed: ${JSON.stringify(res)}`);
  });

  test('company page compiled_truth carries fact SUBSTANCE, not a stub', async () => {
    const page = await engine.getPage('companies/voltcrest', { sourceId: SRC });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('## Facts');
    expect(page!.compiled_truth).toContain('daily-fantasy');
    expect(page!.compiled_truth).toContain('league partnership');
    expect(page!.compiled_truth).not.toContain(STUB_MARKER);
  });

  test('content_chunks carry the fact substance (chunk arm is no longer a stub)', async () => {
    const chunks = await engine.getChunks('companies/voltcrest', { sourceId: SRC });
    const joined = chunks.map(c => c.chunk_text).join('\n');
    expect(joined).toContain('daily-fantasy');
    expect(chunks.some(c => c.chunk_text.includes('Stub page'))).toBe(false);
  });

  test('BUG-CATCHER: keyword search for fact SUBSTANCE (not the name) finds the entity', async () => {
    // The prior 06e93018 test only searched for the entity NAME, which the stub
    // already contained. This searches a token that ONLY exists in the facts.
    const hits = await engine.searchKeyword('daily-fantasy', { sourceId: SRC });
    expect(hits.some(h => h.slug === 'companies/voltcrest')).toBe(true);
  });

  test('hybridSearch (keyword path) surfaces the entity by fact substance', async () => {
    const hits = await hybridSearch(engine, 'league partnership', { sourceId: SRC });
    expect(hits.some(h => h.slug === 'companies/voltcrest')).toBe(true);
  });

  test('person page also materializes from its own leading-mention fact', async () => {
    const page = await engine.getPage('people/robin-hale', { sourceId: SRC });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('## Facts');
    expect(page!.compiled_truth).toContain('founded Voltcrest');
    expect(page!.compiled_truth).not.toContain(STUB_MARKER);
  });

  test('re-running materialize on an unchanged fact set is a no-op (idempotent)', async () => {
    const before = await engine.getPage('companies/voltcrest', { sourceId: SRC });
    const result = await materializeEntityPages(engine, SRC, ['companies/voltcrest']);
    const after = await engine.getPage('companies/voltcrest', { sourceId: SRC });
    expect(result.pagesMaterialized).toBe(0);
    expect(after!.compiled_truth).toBe(before!.compiled_truth);
  });
});

// ---------------------------------------------------------------------------
// B2. materializeEntityPages guards: never clobber authored pages; fact-less
//     pages stay stubs
// ---------------------------------------------------------------------------
describe('materializeEntityPages guards', () => {
  test('NEVER clobbers an authored/enriched page (no save_facts marker)', async () => {
    const slug = 'companies/authored-co';
    const authoredBody = '# Authored Co\n\nHand-written enriched body, unique token quazzlewump.\n';
    await engine.putPage(
      slug,
      { title: 'Authored Co', type: 'company', compiled_truth: authoredBody, timeline: '', frontmatter: { source: 'import' } },
      { sourceId: SRC },
    );
    // A fact IS anchored to it, but the page is authored — must not be rebuilt.
    await engine.insertFact(
      { fact: 'Authored Co raised a Series B', entity_slug: slug, source: 'test', client_authored: true },
      { source_id: SRC },
    );
    const result = await materializeEntityPages(engine, SRC, [slug]);
    const page = await engine.getPage(slug, { sourceId: SRC });
    expect(result.pagesMaterialized).toBe(0);
    expect(page!.compiled_truth).toBe(authoredBody);
    expect(page!.compiled_truth).toContain('quazzlewump');
    expect(page!.compiled_truth).not.toContain('## Facts');
  });

  test('fact-less construct page stays a stub (nothing to materialize)', async () => {
    const slug = 'companies/lonelyco';
    const stub = compileEntityBody('Lonelyco', 'company', []);
    await engine.putPage(
      slug,
      { title: 'Lonelyco', type: 'company', compiled_truth: stub, timeline: '', frontmatter: { source: 'mcp:save_facts' } },
      { sourceId: SRC },
    );
    const result = await materializeEntityPages(engine, SRC, [slug]);
    const page = await engine.getPage(slug, { sourceId: SRC });
    expect(result.pagesMaterialized).toBe(0);
    expect(page!.compiled_truth).toContain(STUB_MARKER);
  });
});

// ---------------------------------------------------------------------------
// C. Ranking — stubs are demoted below real fact-bearing content (Layer 2a)
// ---------------------------------------------------------------------------
function mk(p: Partial<SearchResult> & { slug: string; chunk_id: number; chunk_text: string }): SearchResult {
  return {
    slug: p.slug,
    page_id: p.page_id ?? 1,
    title: p.title ?? p.slug,
    type: p.type ?? 'company',
    chunk_text: p.chunk_text,
    chunk_source: p.chunk_source ?? 'compiled_truth',
    chunk_id: p.chunk_id,
    chunk_index: p.chunk_index ?? 0,
    score: p.score ?? 0,
    stale: p.stale ?? false,
  };
}

const STUB_BODY = `# Stubco\n\n**Type:** Company\n\n## Summary\n\n${STUB_MARKER}\n\n## Timeline\n`;

describe('RRF stub demotion (Layer 2a)', () => {
  const stub = mk({ slug: 'companies/stubco', chunk_id: 5, chunk_text: STUB_BODY });
  const real = mk({ slug: 'companies/realco', chunk_id: 7, chunk_text: '# Realco\n\n## Facts\n\n- Realco raised a Series B at a strong valuation\n' });
  const fact = mk({ slug: 'companies/realco', chunk_id: -3, chunk_text: 'Realco raised a Series B at a strong valuation' });

  test('rrfFusionWeighted: real materialized body outranks an equal-rank stub', () => {
    const fused = rrfFusionWeighted([{ list: [stub], k: 60 }, { list: [real], k: 60 }], true);
    expect(fused[0].slug).toBe('companies/realco');
    const realScore = fused.find(r => r.slug === 'companies/realco')!.score;
    const stubScore = fused.find(r => r.slug === 'companies/stubco')!.score;
    expect(realScore).toBeGreaterThan(stubScore);
    // 2.0x real vs 0.5x stub → ~4x separation from identical RRF rank.
    expect(realScore / stubScore).toBeGreaterThan(3);
  });

  test('rrfFusionWeighted: a fact row (negative chunk_id) outranks a stub', () => {
    const fused = rrfFusionWeighted([{ list: [stub], k: 60 }, { list: [fact], k: 60 }], true);
    expect(fused[0].chunk_id).toBe(-3);
  });

  test('rrfFusion: same demotion in the unweighted variant', () => {
    const fused = rrfFusion([[stub], [real]], 60, true);
    expect(fused[0].slug).toBe('companies/realco');
  });

  test('detail=high (applyBoost=false) neither boosts nor demotes', () => {
    const fused = rrfFusionWeighted([{ list: [stub], k: 60 }, { list: [real], k: 60 }], false);
    const realScore = fused.find(r => r.slug === 'companies/realco')!.score;
    const stubScore = fused.find(r => r.slug === 'companies/stubco')!.score;
    expect(realScore).toBeCloseTo(stubScore, 6);
  });
});

// ---------------------------------------------------------------------------
// D. Facts-arm entity gate — no fixed fallback cluster (Layer 2b)
// ---------------------------------------------------------------------------
describe('gateFactsToMatchedEntities (Layer 2b)', () => {
  const queriedFact = mk({ slug: 'companies/voltcrest', chunk_id: -1, chunk_text: 'Voltcrest is a daily-fantasy startup' });
  const denseClusterFact = mk({ slug: 'people/dense-cluster', chunk_id: -2, chunk_text: 'unrelated fact from the densest cluster' });
  const factsList = [denseClusterFact, queriedFact]; // global NN put the dense cluster first

  test('keeps only facts whose entity was matched by chunk/keyword arms', () => {
    // The chunk/keyword arms matched ONLY companies/voltcrest.
    const matched = [[mk({ slug: 'companies/voltcrest', chunk_id: 9, chunk_text: 'voltcrest chunk' })]];
    const gated = gateFactsToMatchedEntities(factsList, matched);
    expect(gated).toHaveLength(1);
    expect(gated[0].slug).toBe('companies/voltcrest');
    // the densest-cluster fact (wrong entity) is dropped
    expect(gated.some(f => f.slug === 'people/dense-cluster')).toBe(false);
  });

  test('off-world query (nothing matched) → facts arm contributes NOTHING', () => {
    const gated = gateFactsToMatchedEntities(factsList, [[]]);
    expect(gated).toHaveLength(0);
  });
});
