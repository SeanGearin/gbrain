/**
 * B7 save_facts — deterministic graph construct (CC packet 2026-06-15, verdict B).
 *
 * Proves the missing "Construct" step: save_facts now turns each inserted claim's
 * people[]/entities[] arrays into entity stub PAGES + bidirectional co-occurrence
 * EDGES, deterministically and with ZERO inference. Before this, a brain seeded
 * entirely through save_facts had full recall but an EMPTY graph (the 0-pages /
 * 0-links empirical anchor in the packet); these tests are the inverse.
 *
 * Runs entirely on PGLite (in-memory, no DATABASE_URL, no provider keys) — the
 * keyless shape of the production tenant box, so isAvailable('chat'/'embedding')
 * are both false. That makes the zero-LLM claim structural: the graph is built
 * with no provider configured at all. (PGLite's withSourceScope is a pass-through,
 * so these tests exercise the CONSTRUCT LOGIC + source-id column scoping; the
 * gbrain_tenant RLS-isolation half is proven separately on Postgres.)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { constructGraphFromClaim } from '../src/core/facts/construct.ts';

let engine: PGLiteEngine;

const TEST_SOURCES = [
  'tc-unit', 'tc-e2e', 'tc-idem', 'tc-shared', 'tc-single',
  'tc-empty', 'tc-junk', 'tc-dupname', 'tc-cap', 'tc-traverse',
  'tc-scope-x', 'tc-scope-y', 'tc-noclobber', 'tc-resolve-existing',
  'tc-resolve-new', 'tc-resolve-other-a', 'tc-resolve-other-b',
  'tc-person-wins',
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of TEST_SOURCES) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

// --- raw readers (explicit source filter — never rely on getPage's scoping) ---

async function countPages(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  return Number(rows[0].n);
}

async function countLinks(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM links l
       JOIN pages f ON f.id = l.from_page_id
      WHERE f.source_id = $1`,
    [sourceId],
  );
  return Number(rows[0].n);
}

async function getPageRow(
  sourceId: string,
  slug: string,
): Promise<{ slug: string; type: string; title: string } | null> {
  const rows = await engine.executeRaw<{ slug: string; type: string; title: string }>(
    `SELECT slug, type, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [sourceId, slug],
  );
  return rows[0] ?? null;
}

/** Directed edges from→to within a source, with their attribution. */
async function edgesBetween(
  sourceId: string,
  fromSlug: string,
  toSlug: string,
): Promise<Array<{ link_type: string; link_source: string; context: string | null }>> {
  return engine.executeRaw<{ link_type: string; link_source: string; context: string | null }>(
    `SELECT l.link_type, l.link_source, l.context
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.source_id = $1 AND f.slug = $2 AND t.slug = $3`,
    [sourceId, fromSlug, toSlug],
  );
}

// ---------------------------------------------------------------------------

describe('constructGraphFromClaim — unit', () => {
  test('a person + a company → 2 stub pages and a bidirectional edge', async () => {
    const res = await constructGraphFromClaim(engine, 'tc-unit', {
      people: ['Hana Whitfield'],
      entities: ['Beacon Capital'],
      claimText: 'Hana Whitfield leads Beacon Capital',
    });
    expect(res.pagesCreated).toBe(2);
    expect(res.edgesCreated).toBe(2); // one pair, both directions

    const person = await getPageRow('tc-unit', 'people/hana-whitfield');
    expect(person).not.toBeNull();
    expect(person!.type).toBe('person');
    expect(person!.title).toBe('Hana Whitfield');

    const company = await getPageRow('tc-unit', 'companies/beacon-capital');
    expect(company).not.toBeNull();
    expect(company!.type).toBe('company');

    // Edge exists in BOTH directions, attributed to save_facts, with the claim
    // as context (traverseGraph only walks from→to, so both are required).
    const fwd = await edgesBetween('tc-unit', 'people/hana-whitfield', 'companies/beacon-capital');
    const rev = await edgesBetween('tc-unit', 'companies/beacon-capital', 'people/hana-whitfield');
    expect(fwd).toHaveLength(1);
    expect(rev).toHaveLength(1);
    expect(fwd[0].link_type).toBe('co_occurrence'); // the attribution discriminator
    expect(fwd[0].link_source).toBe('manual'); // asserted edge, never text-reconciled
    expect(fwd[0].context).toBe('Hana Whitfield leads Beacon Capital');
  });

  test('re-running the identical claim is idempotent (no dup pages, 0 new edges)', async () => {
    const again = await constructGraphFromClaim(engine, 'tc-unit', {
      people: ['Hana Whitfield'],
      entities: ['Beacon Capital'],
      claimText: 'Hana Whitfield leads Beacon Capital',
    });
    // Both pages already exist (skipped, not re-created); edges ON CONFLICT DO NOTHING.
    expect(again.pagesCreated).toBe(0);
    expect(again.edgesCreated).toBe(0);
    expect(await countPages('tc-unit')).toBe(2);
    expect(await countLinks('tc-unit')).toBe(2);
  });

  test('does NOT clobber an already-enriched entity page', async () => {
    // Simulate a page enriched by some other (customer-plane) path.
    await engine.putPage(
      'people/enriched-one',
      {
        title: 'Enriched One',
        type: 'person',
        compiled_truth: '# Enriched One\n\nA rich bio that must survive a later fact.',
        timeline: '',
        frontmatter: {},
      },
      { sourceId: 'tc-noclobber' },
    );

    const res = await constructGraphFromClaim(engine, 'tc-noclobber', {
      people: ['Enriched One'],
      entities: ['Newco'],
      claimText: 'Enriched One advises Newco',
    });
    // Only Newco is newly created; the enriched page is reused, not rewritten.
    expect(res.pagesCreated).toBe(1);

    const rows = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2`,
      ['tc-noclobber', 'people/enriched-one'],
    );
    expect(rows[0].compiled_truth).toContain('A rich bio that must survive');
    // ...and the edge to Newco was still wired off the reused page.
    expect(await edgesBetween('tc-noclobber', 'people/enriched-one', 'companies/newco')).toHaveLength(1);
  });

  test('resolves a short name to an existing same-source entity instead of minting a duplicate stub', async () => {
    await engine.putPage(
      'people/marcus-vale',
      {
        title: 'Marcus Vale',
        type: 'person',
        compiled_truth: '# Marcus Vale\n\nExisting entity page.',
        timeline: '',
        frontmatter: {},
      },
      { sourceId: 'tc-resolve-existing' },
    );

    const res = await constructGraphFromClaim(engine, 'tc-resolve-existing', {
      people: ['Marcus'],
      entities: ['Beacon Capital'],
      claimText: 'Marcus advises Beacon Capital',
    });
    expect(res.pagesCreated).toBe(1); // Beacon Capital only
    expect(res.edgesCreated).toBe(2);
    expect(await getPageRow('tc-resolve-existing', 'people/marcus-vale')).not.toBeNull();
    expect(await getPageRow('tc-resolve-existing', 'people/marcus')).toBeNull();
    expect(await edgesBetween(
      'tc-resolve-existing',
      'people/marcus-vale',
      'companies/beacon-capital',
    )).toHaveLength(1);
  });

  test('mints a typed stub when the resolver falls back for a genuinely new name', async () => {
    const res = await constructGraphFromClaim(engine, 'tc-resolve-new', {
      people: ['Zelda Morrow'],
      claimText: 'Zelda Morrow started a new project',
    });
    expect(res.pagesCreated).toBe(1);
    expect(res.edgesCreated).toBe(0);
    const page = await getPageRow('tc-resolve-new', 'people/zelda-morrow');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Zelda Morrow');
  });

  test('resolution stays source-scoped; a match in another source does not get reused', async () => {
    await engine.putPage(
      'people/marcus-vale',
      {
        title: 'Marcus Vale',
        type: 'person',
        compiled_truth: '# Marcus Vale\n\nForeign source page.',
        timeline: '',
        frontmatter: {},
      },
      { sourceId: 'tc-resolve-other-a' },
    );

    const res = await constructGraphFromClaim(engine, 'tc-resolve-other-b', {
      people: ['Marcus'],
      entities: ['Local Co'],
      claimText: 'Marcus advises Local Co',
    });
    expect(res.pagesCreated).toBe(2);
    expect(res.edgesCreated).toBe(2);
    expect(await getPageRow('tc-resolve-other-b', 'people/marcus-vale')).toBeNull();
    expect(await getPageRow('tc-resolve-other-b', 'people/marcus')).not.toBeNull();
    expect(await countPages('tc-resolve-other-a')).toBe(1);
    expect(await countPages('tc-resolve-other-b')).toBe(2);
    expect(await edgesBetween('tc-resolve-other-b', 'people/marcus', 'companies/local-co')).toHaveLength(1);
  });
});

describe('save_facts → graph (end to end, the packet inverse)', () => {
  test('a seeded brain now has NON-ZERO pages AND links (was 0/0)', async () => {
    expect(await countPages('tc-e2e')).toBe(0);
    expect(await countLinks('tc-e2e')).toBe(0);

    const res = await runSaveFacts(
      [{
        claim: 'Hana Whitfield, Marcus Vale and Priya Anand met about Beacon Capital',
        provenance: 'user_stated',
        people: ['Hana Whitfield', 'Marcus Vale', 'Priya Anand'],
        entities: ['Beacon Capital'],
      }],
      { engine, sourceId: 'tc-e2e' },
    );
    if ('error' in res) throw new Error(`unexpected: ${res.detail}`);
    expect(res.inserted).toBe(1);

    // 4 distinct entities → 4 pages, 4*3 = 12 directed edges.
    expect(await countPages('tc-e2e')).toBe(4);
    expect(await countLinks('tc-e2e')).toBe(12);
  });

  test('construct does NOT run for a deduped (duplicate) fact', async () => {
    const claim = {
      claim: 'Marcus Vale joined the Acme Co board',
      provenance: 'user_stated' as const,
      people: ['Marcus Vale'],
      entities: ['Acme Co'],
    };
    const first = await runSaveFacts([claim], { engine, sourceId: 'tc-idem' });
    if ('error' in first) throw new Error('unexpected error');
    expect(first.inserted).toBe(1);
    const pagesAfterFirst = await countPages('tc-idem');
    const linksAfterFirst = await countLinks('tc-idem');
    expect(pagesAfterFirst).toBe(2);
    expect(linksAfterFirst).toBe(2);

    // Resend → deduped; construct is skipped, graph unchanged.
    const second = await runSaveFacts([claim], { engine, sourceId: 'tc-idem' });
    if ('error' in second) throw new Error('unexpected error');
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(1);
    expect(await countPages('tc-idem')).toBe(pagesAfterFirst);
    expect(await countLinks('tc-idem')).toBe(linksAfterFirst);
  });

  test('two facts sharing an entity reuse its page and accumulate edges', async () => {
    const a = await runSaveFacts(
      [{ claim: 'Alice Chen advises Acme', provenance: 'user_stated', people: ['Alice Chen'], entities: ['Acme'] }],
      { engine, sourceId: 'tc-shared' },
    );
    if ('error' in a) throw new Error('unexpected error');

    const b = await runSaveFacts(
      [{ claim: 'Bob Stone also advises Acme', provenance: 'user_stated', people: ['Bob Stone'], entities: ['Acme'] }],
      { engine, sourceId: 'tc-shared' },
    );
    if ('error' in b) throw new Error('unexpected error');

    // 3 distinct entities total (Alice, Bob, Acme) — Acme's page is shared, not
    // duplicated. Edges: Alice↔Acme (2) + Bob↔Acme (2) = 4. Alice and Bob never
    // co-occur, so there is no Alice↔Bob edge.
    expect(await countPages('tc-shared')).toBe(3);
    expect(await countLinks('tc-shared')).toBe(4);
    expect(await edgesBetween('tc-shared', 'people/alice-chen', 'people/bob-stone')).toHaveLength(0);
  });

  test('person membership in one claim wins over entities membership elsewhere in the batch', async () => {
    const res = await runSaveFacts(
      [
        {
          claim: 'Athlete Example appeared in the standings',
          provenance: 'user_stated',
          entities: ['Athlete Example'],
        },
        {
          claim: 'Athlete Example is a player',
          provenance: 'user_stated',
          people: ['Athlete Example'],
        },
      ],
      { engine, sourceId: 'tc-person-wins' },
    );
    if ('error' in res) throw new Error('unexpected error');
    expect(res.inserted).toBe(2);

    const person = await getPageRow('tc-person-wins', 'people/athlete-example');
    expect(person).not.toBeNull();
    expect(person!.type).toBe('person');
    expect(await getPageRow('tc-person-wins', 'companies/athlete-example')).toBeNull();
    expect(await countPages('tc-person-wins')).toBe(1);

    const facts = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE source_id = $1 ORDER BY id ASC`,
      ['tc-person-wins'],
    );
    expect(facts.map(f => f.entity_slug)).toEqual([
      'people/athlete-example',
      'people/athlete-example',
    ]);
  });
});

describe('co-occurrence graph is traversable from either endpoint', () => {
  test('traverse_graph reaches the co-mentioned entity in BOTH directions', async () => {
    const res = await runSaveFacts(
      [{
        claim: 'Hana Whitfield co-founded Beacon Capital with Marcus Vale',
        provenance: 'user_stated',
        people: ['Hana Whitfield', 'Marcus Vale'],
        entities: ['Beacon Capital'],
      }],
      { engine, sourceId: 'tc-traverse' },
    );
    if ('error' in res) throw new Error('unexpected error');

    // Seed from the person → reaches the company AND the co-founder.
    const fromPerson = await engine.traverseGraph('people/hana-whitfield', 3, { sourceId: 'tc-traverse' });
    const reachedFromPerson = new Set(fromPerson.map(n => n.slug));
    expect(reachedFromPerson.has('companies/beacon-capital')).toBe(true);
    expect(reachedFromPerson.has('people/marcus-vale')).toBe(true);

    // Seed from the company → reaches both people (only possible because edges
    // are bidirectional; traverseGraph walks from→to only).
    const fromCompany = await engine.traverseGraph('companies/beacon-capital', 3, { sourceId: 'tc-traverse' });
    const reachedFromCompany = new Set(fromCompany.map(n => n.slug));
    expect(reachedFromCompany.has('people/hana-whitfield')).toBe(true);
    expect(reachedFromCompany.has('people/marcus-vale')).toBe(true);
  });
});

describe('edge cases', () => {
  test('a single entity makes a page but no edge', async () => {
    const res = await constructGraphFromClaim(engine, 'tc-single', {
      people: ['Solo Person'],
      claimText: 'Solo Person did a thing',
    });
    expect(res.pagesCreated).toBe(1);
    expect(res.edgesCreated).toBe(0);
    expect(await countLinks('tc-single')).toBe(0);
  });

  test('no entities → no pages, no edges (and the fact still inserts)', async () => {
    const res = await runSaveFacts(
      [{ claim: 'The weather was nice today', provenance: 'user_stated' }],
      { engine, sourceId: 'tc-empty' },
    );
    if ('error' in res) throw new Error('unexpected error');
    expect(res.inserted).toBe(1);
    expect(await countPages('tc-empty')).toBe(0);
    expect(await countLinks('tc-empty')).toBe(0);
  });

  test('a name that slugifies to an empty body is skipped (no junk page)', async () => {
    const res = await constructGraphFromClaim(engine, 'tc-junk', {
      people: ['!!!', '###'], // both slugify to "people/" with no body
      entities: ['Real Co'],
      claimText: 'noise and a real company',
    });
    // Only the real company survives; one entity → no edge.
    expect(res.pagesCreated).toBe(1);
    expect(res.edgesCreated).toBe(0);
    expect(await getPageRow('tc-junk', 'people/')).toBeNull();
    expect(await getPageRow('tc-junk', 'companies/real-co')).not.toBeNull();
  });

  test('repeated / case-variant surface forms collapse to one page, no self-edge', async () => {
    const res = await constructGraphFromClaim(engine, 'tc-dupname', {
      people: ['Marcus Vale', 'marcus vale', 'MARCUS VALE'],
      claimText: 'the same person three ways',
    });
    expect(res.pagesCreated).toBe(1); // one distinct slug
    expect(res.edgesCreated).toBe(0);  // a node never links to itself
    expect(await countPages('tc-dupname')).toBe(1);
  });
});

describe('resource bound', () => {
  test('entities-per-fact is capped (no quadratic edge blow-up)', async () => {
    // 40 distinct names; the construct considers only the first 32. Use varied
    // tokens so this test measures the cap, not fuzzy resolver coalescing.
    const people = [
      'Aster', 'Beryl', 'Cobalt', 'Delta', 'Ember', 'Fable', 'Garnet', 'Harbor',
      'Ion', 'Juno', 'Krypton', 'Lumen', 'Mosaic', 'Nova', 'Onyx', 'Prism',
      'Quartz', 'Riviera', 'Summit', 'Tango', 'Umber', 'Vector', 'Warden', 'Xenon',
      'Yonder', 'Zephyr', 'Atlas', 'Blaze', 'Cipher', 'Dynamo', 'Equinox', 'Fjord',
      'Glyph', 'Helix', 'Indigo', 'Jasper', 'Kepler', 'Lagoon', 'Meridian', 'Nexus',
    ];
    const res = await constructGraphFromClaim(engine, 'tc-cap', {
      people,
      claimText: 'a very crowded claim',
    });
    expect(res.pagesCreated).toBe(32);
    expect(res.edgesCreated).toBe(32 * 31); // bounded, not 40*39
    expect(await countPages('tc-cap')).toBe(32);
    // First-32 (input order) present; the 33rd was dropped from the graph.
    expect(await getPageRow('tc-cap', 'people/fjord')).not.toBeNull();
    expect(await getPageRow('tc-cap', 'people/glyph')).toBeNull();
  });
});

describe('source scoping (column-level; RLS half proven on Postgres)', () => {
  test('construct under one source creates nothing under another', async () => {
    const res = await runSaveFacts(
      [{
        claim: 'Tenant X private graph',
        provenance: 'user_stated',
        people: ['Xavier One'],
        entities: ['Xeno Corp'],
      }],
      { engine, sourceId: 'tc-scope-x' },
    );
    if ('error' in res) throw new Error('unexpected error');

    expect(await countPages('tc-scope-x')).toBe(2);
    expect(await countLinks('tc-scope-x')).toBe(2);
    // Nothing bled into the sibling source.
    expect(await countPages('tc-scope-y')).toBe(0);
    expect(await countLinks('tc-scope-y')).toBe(0);
    expect(await getPageRow('tc-scope-y', 'people/xavier-one')).toBeNull();
  });
});
