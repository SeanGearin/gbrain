/**
 * Offset pagination on the recall + list_pages MCP ops (additive, 2026-06-10).
 *
 * Both ops gained an optional `offset` param that passes through to the
 * already-offset-capable engine methods (listFactsSince / listPages), keeping
 * the existing limit clamp (<=100). This proves a caller can page by
 * offset until a short page to exhaust a >100-fact / >40-page brain with no
 * gaps and no dupes, and that omitting offset is byte-identical to offset 0.
 *
 * Engine offset support itself is exercised in the engine tests; this file is
 * the op-surface contract for the export-completeness consumer.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { NewFact } from '../src/core/engine.ts';

const FACT_COUNT = 120; // > MAX_SEARCH_LIMIT (100) — forces multi-page walk
const PAGE_COUNT = 45;  // > the export's PAGE_ENRICH_CAP (40)

let engine: PGLiteEngine;

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string };

const fixtureFact = (rowNum: number): BatchFact => ({
  fact: `Claim number ${rowNum}`,
  kind: 'fact',
  entity_slug: 'people/alice',
  visibility: 'world',
  notability: 'medium',
  source: 'test:fixture',
  confidence: 1.0,
  row_num: rowNum,
  source_markdown_slug: 'people/alice',
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // 120 active facts on one page (row_num is unique per (source, slug)).
  const rows = Array.from({ length: FACT_COUNT }, (_, i) => fixtureFact(i + 1));
  await engine.insertFacts(rows, { source_id: 'default' });

  // 45 pages with zero-padded slugs so slug-ASC order is deterministic.
  for (let i = 1; i <= PAGE_COUNT; i++) {
    const n = String(i).padStart(3, '0');
    await engine.putPage(`notes/page-${n}`, {
      type: 'note',
      title: `Page ${n}`,
      compiled_truth: `Body for page ${n}.`,
    });
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

// Local trusted caller: remote:false → sees all visibilities, unscoped source.
// Built lazily so it captures the engine assigned in beforeAll, not the
// module-load-time undefined.
const ctx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);

describe('recall op — offset pagination', () => {
  test('paging by offset until a short page walks all 120 facts, no gap, no dupe', async () => {
    const recall = operationsByName['recall'];
    const PAGE = 50;
    const collected: Array<{ id: number }> = [];

    for (let offset = 0; ; offset += PAGE) {
      const res = (await recall.handler(ctx(), { include_expired: true, limit: PAGE, offset })) as { facts: Array<{ id: number }> };
      collected.push(...res.facts);
      if (res.facts.length < PAGE) break;
      if (offset > FACT_COUNT * 2) throw new Error('pagination did not terminate'); // safety net
    }

    expect(collected.length).toBe(FACT_COUNT);
    const ids = collected.map((f) => f.id);
    expect(new Set(ids).size).toBe(FACT_COUNT); // no dupes across boundaries
    // No gap: the union equals the full inserted set (ids 1..120 by row insert).
    const sorted = [...ids].sort((a, b) => a - b);
    expect(sorted[0]).toBeGreaterThan(0);
    expect(sorted[sorted.length - 1] - sorted[0]).toBe(FACT_COUNT - 1);
  });

  test('stable order across page boundaries: strictly descending id (created_at DESC, id DESC)', async () => {
    const recall = operationsByName['recall'];
    const PAGE = 50;
    const collected: Array<{ id: number }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = (await recall.handler(ctx(), { include_expired: true, limit: PAGE, offset })) as { facts: Array<{ id: number }> };
      collected.push(...res.facts);
      if (res.facts.length < PAGE) break;
    }
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i].id).toBeLessThan(collected[i - 1].id);
    }
  });

  test('omitting offset is identical to offset:0; invalid offset clamps to 0', async () => {
    const recall = operationsByName['recall'];
    const base = (await recall.handler(ctx(), { include_expired: true, limit: 10 })) as { facts: Array<{ id: number }> };
    const zero = (await recall.handler(ctx(), { include_expired: true, limit: 10, offset: 0 })) as { facts: Array<{ id: number }> };
    const neg = (await recall.handler(ctx(), { include_expired: true, limit: 10, offset: -5 })) as { facts: Array<{ id: number }> };
    const nan = (await recall.handler(ctx(), { include_expired: true, limit: 10, offset: Number.NaN })) as { facts: Array<{ id: number }> };
    expect(zero.facts.map((f) => f.id)).toEqual(base.facts.map((f) => f.id));
    expect(neg.facts.map((f) => f.id)).toEqual(base.facts.map((f) => f.id));
    expect(nan.facts.map((f) => f.id)).toEqual(base.facts.map((f) => f.id));
  });

  test('offset past the end returns an empty page (clean termination)', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(ctx(), { include_expired: true, limit: 50, offset: FACT_COUNT + 10 })) as { facts: unknown[] };
    expect(res.facts.length).toBe(0);
  });
});

describe('list_pages op — offset pagination', () => {
  test('paging by offset (sort:slug) walks all 45 pages, no gap, no dupe, ascending', async () => {
    const listPages = operationsByName['list_pages'];
    const PAGE = 20;
    const slugs: string[] = [];

    for (let offset = 0; ; offset += PAGE) {
      const res = (await listPages.handler(ctx(), { limit: PAGE, offset, sort: 'slug' })) as Array<{ slug: string }>;
      slugs.push(...res.map((p) => p.slug));
      if (res.length < PAGE) break;
      if (offset > PAGE_COUNT * 2) throw new Error('pagination did not terminate');
    }

    const ours = slugs.filter((s) => s.startsWith('notes/page-'));
    expect(ours.length).toBe(PAGE_COUNT);
    expect(new Set(ours).size).toBe(PAGE_COUNT); // no dupes
    const ascending = [...ours].sort();
    expect(ours).toEqual(ascending); // slug ASC is stable across boundaries
  });

  test('omitting offset matches offset:0', async () => {
    const listPages = operationsByName['list_pages'];
    const base = (await listPages.handler(ctx(), { limit: 10, sort: 'slug' })) as Array<{ slug: string }>;
    const zero = (await listPages.handler(ctx(), { limit: 10, offset: 0, sort: 'slug' })) as Array<{ slug: string }>;
    expect(zero.map((p) => p.slug)).toEqual(base.map((p) => p.slug));
  });
});
