/**
 * SR-2 / SR-3 / SR-9 (engine audit 2026-07-17) — recall op honesty.
 *
 *   SR-2: `total` was `rows.length` — the POST-LIMIT page length presented as
 *         the record's total, so any has_more derivation always concluded
 *         "complete". Fix: `total` is a real COUNT(*) of every row matching
 *         the request's filter (branch + grep + visibility + activeOnly),
 *         computed pre-LIMIT; the response adds `has_more` and a `window`
 *         echo `{ offset, limit, returned }`.
 *   SR-3: `grep` was applied in JS AFTER the SQL LIMIT page — matching facts
 *         outside the newest-limit window were silently unreachable and the
 *         op asserted `{facts: [], total: 0}` while matches existed. Fix:
 *         grep is an engine-side ILIKE predicate applied BEFORE LIMIT.
 *   SR-9: an unparseable `since` silently degraded to `{facts:[], total:0}`.
 *         Fix: loud OperationError('invalid_since').
 *
 * Red-first: every assertion tagged RED fails at the audit sha (5190c7f2).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { NewFact } from '../src/core/engine.ts';

const FACT_COUNT = 120; // > default limit 50 and > MAX_SEARCH_LIMIT clamp path

let engine: PGLiteEngine;

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string };

const fixtureFact = (rowNum: number, text: string): BatchFact => ({
  fact: text,
  kind: 'fact',
  entity_slug: 'people/alice',
  visibility: 'world',
  notability: 'medium',
  source: 'test:fixture',
  confidence: 1.0,
  row_num: rowNum,
  source_markdown_slug: 'people/alice',
});

// kumquat rows scattered through the set — several land OUTSIDE the
// newest-50 window (row_num 1 = smallest id = OLDEST in created_at DESC,
// id DESC order).
const KUMQUAT_ROWS = new Set([10, 30, 55, 70, 90, 110, 119]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Anchor page so resolveEntitySlug('people/alice') exact-matches itself
  // instead of falling through to the slugify fallback.
  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice',
    compiled_truth: 'Alice is the fixture entity.',
  });

  const rows: BatchFact[] = [];
  for (let i = 1; i <= FACT_COUNT; i++) {
    if (i === 1) {
      // The only 'invoice' fact — OLDEST row, far outside the newest-50 window.
      rows.push(fixtureFact(i, `Claim ${i} about the missing invoice from Acme`));
    } else if (KUMQUAT_ROWS.has(i)) {
      rows.push(fixtureFact(i, `Claim ${i} mentions a kumquat delivery`));
    } else {
      rows.push(fixtureFact(i, `Claim number ${i}`));
    }
  }
  await engine.insertFacts(rows, { source_id: 'default' });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const ctx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);

type RecallPayload = {
  facts: Array<{ id: number; fact: string }>;
  total: number;
  has_more: boolean;
  window: { offset: number; limit: number; returned: number };
};

describe('SR-2 — recall total is the real matching-row count, not the page length', () => {
  test('a capped page reports the full total and has_more=true', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { limit: 50 })) as RecallPayload;
    expect(res.facts.length).toBe(50);
    expect(res.total).toBe(FACT_COUNT);        // RED pre-fix: 50
    expect(res.has_more).toBe(true);           // RED pre-fix: undefined
    expect(res.window).toEqual({ offset: 0, limit: 50, returned: 50 });
  });

  test('the last page reports has_more=false with the same total', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { limit: 50, offset: 100 })) as RecallPayload;
    expect(res.facts.length).toBe(20);
    expect(res.total).toBe(FACT_COUNT);        // RED pre-fix: 20
    expect(res.has_more).toBe(false);
    expect(res.window).toEqual({ offset: 100, limit: 50, returned: 20 });
  });

  test('window.limit reports the CLAMPED effective limit, not the raw request', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { limit: 500 })) as RecallPayload;
    expect(res.facts.length).toBe(100);        // engine clamp MAX_SEARCH_LIMIT
    expect(res.window.limit).toBe(100);
    expect(res.total).toBe(FACT_COUNT);
    expect(res.has_more).toBe(true);
  });

  test('worker derivation offset + facts.length < total is now correct', async () => {
    const recall = operationsByName['recall'];
    const p1 = (await recall.handler(ctx(), { limit: 50, offset: 0 })) as RecallPayload;
    const p2 = (await recall.handler(ctx(), { limit: 50, offset: 50 })) as RecallPayload;
    const p3 = (await recall.handler(ctx(), { limit: 50, offset: 100 })) as RecallPayload;
    expect(0 + p1.facts.length < p1.total).toBe(true);   // RED pre-fix: false
    expect(50 + p2.facts.length < p2.total).toBe(true);  // RED pre-fix: false
    expect(100 + p3.facts.length < p3.total).toBe(false);
  });
});

describe('SR-3 — grep filters BEFORE the SQL LIMIT', () => {
  test('a match outside the newest-50 window is found', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { grep: 'invoice', limit: 50 })) as RecallPayload;
    expect(res.facts.length).toBe(1);          // RED pre-fix: 0 (cap-before-filter starvation)
    expect(res.facts[0].fact).toContain('invoice');
    expect(res.total).toBe(1);
    expect(res.has_more).toBe(false);
  });

  test('grep is case-insensitive (parity with the old toLowerCase contract)', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { grep: 'INVOICE', limit: 50 })) as RecallPayload;
    expect(res.facts.length).toBe(1);
  });

  test('grep with LIKE metacharacters is treated literally', async () => {
    const recall = operationsByName['recall'];
    // '%' matched nothing under the old .includes contract; it must not
    // become a wildcard under ILIKE.
    const res = (await recall.handler(ctx(), { grep: '100% legit', limit: 50 })) as RecallPayload;
    expect(res.facts.length).toBe(0);
    expect(res.total).toBe(0);
  });

  test('paging a grep-filtered set walks every match with a stable total', async () => {
    const recall = operationsByName['recall'];
    const collected: number[] = [];
    let total = -1;
    for (let offset = 0; ; offset += 3) {
      const res = (await recall.handler(ctx(), { grep: 'kumquat', limit: 3, offset })) as RecallPayload;
      total = res.total;
      collected.push(...res.facts.map((f) => f.id));
      expect(res.total).toBe(KUMQUAT_ROWS.size); // RED pre-fix: page length, 0 on starved pages
      if (!res.has_more) break;
      if (offset > FACT_COUNT) throw new Error('pagination did not terminate');
    }
    expect(collected.length).toBe(KUMQUAT_ROWS.size); // RED pre-fix: starved
    expect(new Set(collected).size).toBe(KUMQUAT_ROWS.size);
    expect(total).toBe(KUMQUAT_ROWS.size);
  });
});

describe('SR-9 — unparseable since is a loud error, not an empty success', () => {
  test('recall({since:"not-a-date"}) throws invalid_since', async () => {
    const recall = operationsByName['recall'];
    // RED pre-fix: resolves to {facts: [], total: 0} — indistinguishable from
    // a true no-match.
    await expect(recall.handler(ctx(), { since: 'yesterday-ish garbage' })).rejects.toThrow(OperationError);
    try {
      await recall.handler(ctx(), { since: 'yesterday-ish garbage' });
    } catch (e) {
      expect((e as OperationError & { code?: string }).code).toBe('invalid_since');
    }
  });

  test('a VALID since still works and carries the honest total', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { since: '1970-01-01T00:00:00Z', limit: 10 })) as RecallPayload;
    expect(res.facts.length).toBe(10);
    expect(res.total).toBe(FACT_COUNT);
    expect(res.has_more).toBe(true);
  });
});

describe('entity branch carries the same honest total', () => {
  test('entity-filtered recall reports the entity-filtered count', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { entity: 'people/alice', limit: 10 })) as RecallPayload;
    expect(res.facts.length).toBe(10);
    expect(res.total).toBe(FACT_COUNT);        // RED pre-fix: 10
    expect(res.has_more).toBe(true);
  });
});
