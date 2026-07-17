/**
 * SR-5 + SR-4 (engine audit 2026-07-17) — recall supersessions branch.
 *
 *   SR-5: the supersessions branch ignored `offset` and clamped limit at 100
 *         (listSupersessions had no offset in its signature) — supersession
 *         history beyond 100 rows was PERMANENTLY unreachable by any
 *         parameter combination, and a pager following the op's own
 *         documented protocol looped on identical pages.
 *   SR-4: the branch also dropped the visibility/ownerSourceId filter every
 *         other branch applies — a remote world-only caller could read
 *         PRIVATE expired fact text through the audit-log side door. Fixed
 *         here as a structural byproduct of SR-5 (the fix threads the same
 *         listOpts every sibling branch already passes).
 *
 * Also covers the honest total/has_more (SR-2) on this branch and loud
 * invalid-since (SR-9 parity).
 *
 * Red-first: RED-tagged assertions fail at the audit sha (5190c7f2).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { NewFact } from '../src/core/engine.ts';

const SUPERSEDED_WORLD = 249; // world-visible superseded rows
const PRIVATE_TEXT = 'PRIVATE superseded claim — must never reach a world reader';

let engine: PGLiteEngine;
let expectedIds: number[] = [];
let privateId = -1;

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const rows: BatchFact[] = [];
  // 1 survivor + 249 world rows to supersede + 1 private row to supersede.
  rows.push({
    fact: 'Surviving canonical claim',
    kind: 'fact', entity_slug: 'people/alice', visibility: 'world',
    notability: 'medium', source: 'test:fixture', confidence: 1.0,
    row_num: 1, source_markdown_slug: 'people/alice',
  });
  for (let i = 2; i <= SUPERSEDED_WORLD + 1; i++) {
    rows.push({
      fact: `Old claim ${i}`,
      kind: 'fact', entity_slug: 'people/alice', visibility: 'world',
      notability: 'medium', source: 'test:fixture', confidence: 1.0,
      row_num: i, source_markdown_slug: 'people/alice',
    });
  }
  rows.push({
    fact: PRIVATE_TEXT,
    kind: 'fact', entity_slug: 'people/alice', visibility: 'private',
    notability: 'medium', source: 'test:fixture', confidence: 1.0,
    row_num: SUPERSEDED_WORLD + 2, source_markdown_slug: 'people/alice',
  });

  const { ids } = await engine.insertFacts(rows, { source_id: 'default' });
  const survivorId = ids[0];
  const toExpire = ids.slice(1);
  privateId = ids[ids.length - 1];
  for (const id of toExpire) {
    await engine.expireFact(id, { supersededBy: survivorId });
  }
  expectedIds = toExpire; // 250 superseded rows total (249 world + 1 private)
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const localCtx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);
// Remote unscoped/world-only caller (no owner carve-out): sourceScopeActive
// short-circuits the withSourceScope RLS wrapper — visibility filtering is
// the layer under test here.
const remoteCtx = (): OperationContext =>
  ({ engine, remote: true, sourceId: 'default', sourceScopeActive: true, auth: {} } as unknown as OperationContext);

type RecallPayload = {
  facts: Array<{ id: number; fact: string }>;
  total: number;
  has_more: boolean;
  window: { offset: number; limit: number; returned: number };
};

describe('SR-5 — supersession history beyond 100 rows is reachable via offset', () => {
  test('offset paging walks all 250 supersessions, no gap, no dupe', async () => {
    const recall = operationsByName['recall'];
    const collected: number[] = [];
    let prevFirst = -1;
    for (let offset = 0; ; offset += 100) {
      const res = (await recall.handler(localCtx(), { supersessions: true, limit: 100, offset })) as RecallPayload;
      if (res.facts.length > 0 && res.facts[0].id === prevFirst) {
        // Pre-fix behavior: offset silently ignored → identical pages forever.
        break;
      }
      prevFirst = res.facts.length > 0 ? res.facts[0].id : prevFirst;
      collected.push(...res.facts.map((f) => f.id));
      if (res.facts.length < 100) break;
      if (offset > 1000) throw new Error('pagination did not terminate');
    }
    expect(collected.length).toBe(expectedIds.length);            // RED pre-fix: 100
    expect(new Set(collected).size).toBe(expectedIds.length);     // no dupes
    expect(new Set(collected)).toEqual(new Set(expectedIds));     // no gaps
  });

  test('honest total + has_more on the supersessions branch (SR-2)', async () => {
    const recall = operationsByName['recall'];
    const p1 = (await recall.handler(localCtx(), { supersessions: true, limit: 100 })) as RecallPayload;
    expect(p1.facts.length).toBe(100);
    expect(p1.total).toBe(expectedIds.length);                    // RED pre-fix: 100
    expect(p1.has_more).toBe(true);                               // RED pre-fix: undefined
    const p3 = (await recall.handler(localCtx(), { supersessions: true, limit: 100, offset: 200 })) as RecallPayload;
    expect(p3.facts.length).toBe(50);
    expect(p3.has_more).toBe(false);
  });

  test('since still filters the supersessions branch after the refactor', async () => {
    const recall = operationsByName['recall'];
    const all = (await recall.handler(localCtx(), { supersessions: true, since: '1970-01-01T00:00:00Z', limit: 100 })) as RecallPayload;
    expect(all.total).toBe(expectedIds.length);
    const none = (await recall.handler(localCtx(), { supersessions: true, since: '2099-01-01T00:00:00Z', limit: 100 })) as RecallPayload;
    expect(none.facts.length).toBe(0);
    expect(none.total).toBe(0);
    expect(none.has_more).toBe(false);
  });

  test('unparseable since on the supersessions branch throws (SR-9 parity)', async () => {
    const recall = operationsByName['recall'];
    await expect(
      recall.handler(localCtx(), { supersessions: true, since: 'complete garbage' }),
    ).rejects.toThrow(OperationError);
  });
});

describe('SR-4 — supersessions branch applies the visibility filter', () => {
  test('a remote world-only caller cannot read private expired fact text', async () => {
    const recall = operationsByName['recall'];
    const collected: Array<{ id: number; fact: string }> = [];
    for (let offset = 0; ; offset += 100) {
      const res = (await recall.handler(remoteCtx(), { supersessions: true, limit: 100, offset })) as RecallPayload;
      collected.push(...res.facts);
      if (res.facts.length < 100) break;
      if (offset > 1000) throw new Error('pagination did not terminate');
    }
    const ids = collected.map((f) => f.id);
    expect(ids).not.toContain(privateId);                         // RED pre-fix: contains
    for (const f of collected) expect(f.fact).not.toBe(PRIVATE_TEXT);
    expect(collected.length).toBe(SUPERSEDED_WORLD);              // world-only count
  });

  test('remote total counts world-only rows (count/list predicate parity)', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(remoteCtx(), { supersessions: true, limit: 100 })) as RecallPayload;
    expect(res.total).toBe(SUPERSEDED_WORLD);                     // RED pre-fix
  });

  test('the local operator plane still sees the private superseded row', async () => {
    const recall = operationsByName['recall'];
    const res = (await recall.handler(localCtx(), { supersessions: true, limit: 100, grep: 'PRIVATE superseded' })) as RecallPayload;
    expect(res.facts.length).toBe(1);
    expect(res.facts[0].id).toBe(privateId);
  });
});
