/**
 * SR-8 (engine audit 2026-07-17) — search op keyword-only branch: dedup ran
 * AFTER the SQL limit/offset window.
 *
 * Two failures at the audit sha (5190c7f2):
 *   1. Permanent pagination skip: offsets were computed on RAW SQL windows and
 *      dedup ran per-window — rows deduped out of window [0,20) were never
 *      re-served in window [20,40).
 *   2. Homogeneous-corpus shrink: enforceTypeDiversity hard-drops rows over
 *      ceil(len*0.6) per type, so on a one-type corpus EVERY page came back
 *      short (20 → 12) and a page-until-short-page walker concluded
 *      "complete" on page 1 with most of the corpus unseen.
 *
 * Fix contract (fix/engine-search-honesty):
 *   - The op fetches the raw prefix [0, offset+limit+headroom) from SQL,
 *     dedups the PREFIX with prefix-stable layers (type-diversity hard-drop
 *     is disabled on this pagination path — it is a page-composition nicety,
 *     not a correctness dedup, and its len-dependence breaks paging), then
 *     slices [offset, offset+limit). Pages are full until the set is
 *     exhausted; nothing is silently skipped between pages.
 *   - The search/query ops now return `{ results, search_health }` — see
 *     search-health-degraded.serial.test.ts for the degradation contract.
 *
 * Red-first: RED-tagged assertions fail at the audit sha.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const PAGE_COUNT = 30; // all type 'note' — homogeneous on purpose

let engine: PGLiteEngine;

function filler(i: number): string {
  return `k${i}alpha k${i}beta k${i}gamma k${i}delta k${i}epsilon k${i}zeta`;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.mcp_keyword_only', 'true');

  for (let i = 1; i <= PAGE_COUNT; i++) {
    const n = String(i).padStart(3, '0');
    const body = `quokka sighting entry ${n} ${filler(i)}`;
    await engine.putPage(`kw/kw-${n}`, {
      type: 'note',
      title: `Quokka Note ${n}`,
      compiled_truth: body,
    });
    // searchKeyword scans content_chunks — seed one chunk per page.
    await engine.upsertChunks(`kw/kw-${n}`, [{
      chunk_index: 0,
      chunk_text: body,
      chunk_source: 'compiled_truth',
      token_count: 16,
    }]);
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const ctx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);

type SearchEnvelope = {
  results: Array<{ slug: string }>;
  search_health: { degraded: boolean; vector_enabled: boolean; mode?: string };
};

/** Unwraps both pre-fix (bare array) and post-fix (envelope) shapes so the
 *  pagination walker itself runs on either build — the COUNT assertions are
 *  what turn red pre-fix. */
function rowsOf(res: unknown): Array<{ slug: string }> {
  if (Array.isArray(res)) return res as Array<{ slug: string }>;
  return (res as SearchEnvelope).results;
}

describe('SR-8 — keyword-only pagination dedups the prefix, not the window', () => {
  test('page-until-short-page walks ALL pages of a homogeneous corpus, no dupes', async () => {
    const search = operationsByName['search'];
    const LIMIT = 20;
    const collected: string[] = [];
    for (let offset = 0; ; offset += LIMIT) {
      const res = await search.handler(ctx(), { query: 'quokka', limit: LIMIT, offset });
      const rows = rowsOf(res);
      collected.push(...rows.map((r) => r.slug));
      if (rows.length < LIMIT) break;
      if (offset > PAGE_COUNT * 4) throw new Error('pagination did not terminate');
    }
    const ours = collected.filter((s) => s.startsWith('kw/kw-'));
    expect(new Set(ours).size).toBe(PAGE_COUNT); // RED pre-fix: 12 (60% type cap shrank page 1 → walker stopped)
    expect(ours.length).toBe(new Set(ours).size); // no dupes across pages
  }, 60_000);

  test('the first page is FULL when enough matching rows exist', async () => {
    const search = operationsByName['search'];
    const res = await search.handler(ctx(), { query: 'quokka', limit: 20, offset: 0 });
    // RED pre-fix: 12 rows — a short page falsely signaling completion.
    expect(rowsOf(res).length).toBe(20);
  });

  test('pages are disjoint windows of one stable ordering', async () => {
    const search = operationsByName['search'];
    const p1 = rowsOf(await search.handler(ctx(), { query: 'quokka', limit: 20, offset: 0 }));
    const p2 = rowsOf(await search.handler(ctx(), { query: 'quokka', limit: 20, offset: 20 }));
    const s1 = new Set(p1.map((r) => r.slug));
    for (const r of p2) expect(s1.has(r.slug)).toBe(false); // RED pre-fix: overlap/skip artifacts
  });

  test('keyword-only responses carry the search_health envelope', async () => {
    const search = operationsByName['search'];
    const res = (await search.handler(ctx(), { query: 'quokka', limit: 5 })) as SearchEnvelope;
    expect(Array.isArray(res.results)).toBe(true);            // RED pre-fix: bare array
    expect(res.search_health).toEqual({
      degraded: false,
      vector_enabled: false,
      mode: 'keyword_only',
    });
  });
});
