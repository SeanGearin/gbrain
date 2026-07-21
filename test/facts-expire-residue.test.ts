/**
 * FIX 1 additions (v2 remediation, adversarial review
 * cc-findings_2026-07-21_engine-bundle-review F1-1 + F1-2).
 *
 * F1-1 (HIGH): a co-occurrence edge stores the FULL forgotten claim text
 * verbatim (constructGraphFromClaim stamps `context = claimText.slice(0,500)`
 * into every edge), and the expire path never cleans it — so after a forget,
 * `getLinks` / `traverse_graph` still return the forgotten value word for word.
 * The review reproduced this end-to-end; the first test below IS that repro.
 * Same gap on the supersede path (shares the no-link-cleanup code path).
 *
 * F1-2 (MEDIUM): `bumpHotMemoryCache` is a fully-implemented invalidator with
 * no production caller, so a just-forgotten fact keeps riding the 30-second
 * `_meta.brain_hot_memory` cache on the next tool response.
 *
 * Both fixes are best-effort / savepoint-contained exactly like the existing
 * re-materialize — they can NEVER undo the primary forget/expire.
 *
 * RED on 72ff1a1 (the v1 bundle tip), GREEN after the v2 fix.
 * PGLite, in-memory, no provider keys.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import {
  getBrainHotMemoryMeta,
  __resetHotMemoryCacheForTests,
} from '../src/core/facts/meta-hook.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;

const TEST_SOURCES = [
  'tenant-edge-forget', 'tenant-edge-supersede', 'tenant-hotcache-forget', 'tenant-hotcache-supersede',
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

beforeEach(() => {
  __resetHotMemoryCacheForTests();
});

function ctx(sourceId: string, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
    ...overrides,
  } as OperationContext;
}

/** Every co_occurrence edge context string reachable from `slug`, joined. */
async function coOccurrenceContexts(slug: string, sourceId: string): Promise<string> {
  const links = await engine.getLinks(slug, { sourceId });
  return links
    .filter((l) => l.link_type === 'co_occurrence')
    .map((l) => l.context ?? '')
    .join('\n');
}

describe('F1-1: expire path cleans co-occurrence edge residue', () => {
  test("forget: getLinks no longer returns the forgotten claim text verbatim (the review's repro)", async () => {
    const SRC = 'tenant-edge-forget';
    const CLAIM = 'Wexler Dynamics pays a secret retainer of forty thousand dollars to Boltline';
    const save = await runSaveFacts(
      [{ claim: CLAIM, entities: ['Wexler Dynamics', 'Boltline'], provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in save).toBe(false);
    if ('error' in save) return;
    const factId = save.fact_ids[0];

    // Precondition: the co-occurrence edge exists and carries the claim verbatim.
    expect(await coOccurrenceContexts('companies/wexler-dynamics', SRC)).toContain('secret retainer');
    expect(await coOccurrenceContexts('companies/boltline', SRC)).toContain('secret retainer');

    const forgot = await forgetFactInFence(engine, factId);
    expect(forgot.ok).toBe(true);

    // Facts arm control: the row really is expired.
    const active = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND expired_at IS NULL AND fact ILIKE '%secret retainer%'`,
      [SRC],
    );
    expect(Number(active[0]?.n)).toBe(0);

    // THE FIX: the graph read path no longer surfaces the forgotten value —
    // from EITHER endpoint (edges are bidirectional).
    expect(await coOccurrenceContexts('companies/wexler-dynamics', SRC)).not.toContain('secret retainer');
    expect(await coOccurrenceContexts('companies/boltline', SRC)).not.toContain('secret retainer');
  });

  test('supersede: the corrected-away claim text stops surfacing on the graph read path', async () => {
    const SRC = 'tenant-edge-supersede';
    const OLD_CLAIM = 'Northwind pays a hidden referral fee of Kestrel-6620 dollars to Apex Partners';
    const first = await runSaveFacts(
      [{ claim: OLD_CLAIM, entities: ['Northwind', 'Apex Partners'], provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    const oldId = first.fact_ids[0];
    expect(await coOccurrenceContexts('companies/northwind', SRC)).toContain('Kestrel-6620');

    const second = await runSaveFacts(
      [{
        claim: 'Northwind pays a standard referral fee of Merlin-8850 dollars to Apex Partners',
        entities: ['Northwind', 'Apex Partners'],
        supersedes: oldId,
        provenance: 'user_stated',
      }],
      { engine, sourceId: SRC },
    );
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.superseded).toBe(1);

    // THE FIX: the old claim's edge context is gone; the correction's edge stands.
    const contexts = await coOccurrenceContexts('companies/northwind', SRC);
    expect(contexts).not.toContain('Kestrel-6620');
    expect(contexts).toContain('Merlin-8850');
  });
});

describe('F1-2: a just-forgotten fact does not ride the 30s _meta hot-memory cache', () => {
  test('forget invalidates the cached brain_hot_memory payload (no-session entry)', async () => {
    const SRC = 'tenant-hotcache-forget';
    const save = await runSaveFacts(
      [{ claim: 'The Vega-4417 launch code is stored in the ops vault', provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in save).toBe(false);
    if ('error' in save) return;
    const factId = save.fact_ids[0];

    // Prime the cache (get_stats is not a hot-memory-exempt tool name).
    const first = await getBrainHotMemoryMeta('get_stats', ctx(SRC));
    expect(JSON.stringify(first ?? {})).toContain('Vega-4417');

    const forgot = await forgetFactInFence(engine, factId);
    expect(forgot.ok).toBe(true);

    // THE FIX: the next tool response's _meta must NOT carry the forgotten fact
    // (pre-fix it rides the 30s TTL cache).
    const second = await getBrainHotMemoryMeta('get_stats', ctx(SRC));
    expect(JSON.stringify(second ?? {})).not.toContain('Vega-4417');
  });

  test('forget also invalidates SESSION-scoped cache entries for the source', async () => {
    const SRC = 'tenant-hotcache-forget';
    const inserted = await engine.insertFact(
      {
        fact: 'The Lyra-3306 badge unlocks the server room',
        kind: 'fact',
        entity_slug: null,
        visibility: 'private',
        source: 'test',
        source_session: 'sess-hot-1',
      },
      { source_id: SRC },
    );
    const sessionCtx = ctx(SRC, { source_session: 'sess-hot-1' } as Partial<OperationContext>);
    const first = await getBrainHotMemoryMeta('get_stats', sessionCtx);
    expect(JSON.stringify(first ?? {})).toContain('Lyra-3306');

    const forgot = await forgetFactInFence(engine, inserted.id);
    expect(forgot.ok).toBe(true);

    // The forget site does not know the session — the bump must clear EVERY
    // session's entries for the source, or this session keeps the stale payload.
    const second = await getBrainHotMemoryMeta('get_stats', sessionCtx);
    expect(JSON.stringify(second ?? {})).not.toContain('Lyra-3306');
  });

  test('supersede invalidates the cached payload (the corrected-away value stops riding _meta)', async () => {
    const SRC = 'tenant-hotcache-supersede';
    const save = await runSaveFacts(
      [{ claim: 'The staging database password rotation happens every Orion-2214 days', provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in save).toBe(false);
    if ('error' in save) return;
    const oldId = save.fact_ids[0];

    const first = await getBrainHotMemoryMeta('get_stats', ctx(SRC));
    expect(JSON.stringify(first ?? {})).toContain('Orion-2214');

    const correction = await runSaveFacts(
      [{
        claim: 'The staging database password rotation happens every Draco-7731 days',
        supersedes: oldId,
        provenance: 'user_stated',
      }],
      { engine, sourceId: SRC },
    );
    expect('error' in correction).toBe(false);
    if ('error' in correction) return;
    expect(correction.superseded).toBe(1);

    const second = await getBrainHotMemoryMeta('get_stats', ctx(SRC));
    expect(JSON.stringify(second ?? {})).not.toContain('Orion-2214');
    expect(JSON.stringify(second ?? {})).toContain('Draco-7731');
  });
});
