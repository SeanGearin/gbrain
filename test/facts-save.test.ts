/**
 * B7 save_facts (pass 1) — deterministic structured-facts intake.
 *
 * Runs entirely on PGLite (in-memory, no DATABASE_URL, no provider keys), which
 * is exactly the keyless shape of the production tenant box: isAvailable('chat')
 * and isAvailable('embedding') are both false, so this exercises the Layer-1
 * (pg_trgm / normalized-exact) dedup path and proves the tool inserts at zero
 * inference with no chat dependency.
 *
 * Maps to packet B-SF4 verification items:
 *   (a) insert at $0, no chat call          → "inserts at zero inference"
 *   (b) immediate resend → duplicate         → "resend dedups"
 *   (c) missing provenance → reject w/ index  → "validation"
 *   (d) provenance + client_authored in row   → "stamping"
 *   (e) no embedding key → dedup_mode 'trgm'  → "graceful degrade"
 *   (h, app-level half) source scoping         → "no cross-source dedup/leak"
 *
 * Items needing the deployed box are listed in the findings doc:
 *   (a-journal) journal shows zero provider rows; (f) embedding-key Layer 2;
 *   (g) operator extract_facts unchanged; (h-RLS) the gbrain_tenant role half.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

// facts.source_id has an FK to sources(id); seed every tenant id the tests use.
const TEST_SOURCES = [
  'tenant-a', 'tenant-dedup', 'tenant-near', 'tenant-batchdup',
  'tenant-validate', 'tenant-atomic', 'tenant-x', 'tenant-y',
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

// Raw column read — provenance/client_authored are write-only columns (not on
// FactRow, matching the claim_metric/event_type precedent), so verify directly.
async function readFactRaw(id: number): Promise<{
  source: string;
  client_authored: boolean;
  provenance: string | null;
  confidence: number;
  entity_slug: string | null;
  visibility: string;
  context: string | null;
}> {
  const rows = await engine.executeRaw<{
    source: string;
    client_authored: boolean;
    provenance: string | null;
    confidence: number | string;
    entity_slug: string | null;
    visibility: string;
    context: string | null;
  }>(
    `SELECT source, client_authored, provenance, confidence, entity_slug, visibility, context
     FROM facts WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return {
    source: row.source,
    client_authored: row.client_authored,
    provenance: row.provenance,
    confidence: typeof row.confidence === 'string' ? parseFloat(row.confidence) : row.confidence,
    entity_slug: row.entity_slug,
    visibility: row.visibility,
    context: row.context,
  };
}

describe('save_facts — insert + stamping (B-SF4 a, d, e)', () => {
  test('inserts a user_stated claim at $0, stamps the row, dedup_mode trgm', async () => {
    const res = await runSaveFacts(
      [
        {
          claim: 'Priya is allergic to penicillin',
          provenance: 'user_stated',
          people: ['Priya'],
          kind: 'fact',
        },
      ],
      { engine, sourceId: 'tenant-a' },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.inserted).toBe(1);
    expect(res.duplicate).toBe(0);
    expect(res.fact_ids).toHaveLength(1);
    expect(res.dedup_mode).toBe('trgm'); // no embedding provider in this env

    const row = await readFactRaw(res.fact_ids[0]);
    expect(row.source).toBe('mcp:save_facts');
    expect(row.client_authored).toBe(true);
    expect(row.provenance).toBe('user_stated');
    expect(row.confidence).toBe(1.0);
    expect(row.entity_slug).toBeNull();
    expect(row.visibility).toBe('private');
    expect(row.context).toContain('Priya');
  });

  test('model_inferred confidence is hard-capped at 0.7', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Priya probably prefers morning meetings', provenance: 'model_inferred', confidence: 0.95 }],
      { engine, sourceId: 'tenant-a' },
    );
    if ('error' in res) throw new Error('unexpected validation error');
    expect(res.inserted).toBe(1);
    const row = await readFactRaw(res.fact_ids[0]);
    expect(row.provenance).toBe('model_inferred');
    expect(row.confidence).toBeCloseTo(0.7, 5);
  });
});

describe('save_facts — dedup (B-SF4 b)', () => {
  test('immediate resend of the same claim returns duplicate, not insert', async () => {
    const claim = { claim: 'Sean booked a dentist appointment for June 13', provenance: 'user_stated' as const };
    const first = await runSaveFacts([claim], { engine, sourceId: 'tenant-dedup' });
    if ('error' in first) throw new Error('unexpected error');
    expect(first.inserted).toBe(1);

    const second = await runSaveFacts([claim], { engine, sourceId: 'tenant-dedup' });
    if ('error' in second) throw new Error('unexpected error');
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(1);
    // dedup returns the existing row id
    expect(second.fact_ids).toEqual(first.fact_ids);
  });

  test('normalized near-dup (case + whitespace) dedups via Layer 1', async () => {
    const a = await runSaveFacts(
      [{ claim: 'Billy Bob plays golf on Saturdays', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-near' },
    );
    if ('error' in a) throw new Error('unexpected error');
    expect(a.inserted).toBe(1);

    const b = await runSaveFacts(
      [{ claim: '  billy   bob   PLAYS golf on saturdays  ', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-near' },
    );
    if ('error' in b) throw new Error('unexpected error');
    expect(b.inserted).toBe(0);
    expect(b.duplicate).toBe(1);
  });

  test('a batch containing the same claim twice inserts it once', async () => {
    const res = await runSaveFacts(
      [
        { claim: 'Marcus owns Beacon Properties', provenance: 'user_stated' },
        { claim: 'Marcus owns Beacon Properties', provenance: 'user_stated' },
      ],
      { engine, sourceId: 'tenant-batchdup' },
    );
    if ('error' in res) throw new Error('unexpected error');
    expect(res.inserted).toBe(1);
    expect(res.duplicate).toBe(1);
  });
});

describe('save_facts — validation rejects whole batch with index (B-SF4 c)', () => {
  test('missing provenance → invalid_claim at the offending index', async () => {
    const res = await runSaveFacts(
      [
        { claim: 'valid one', provenance: 'user_stated' },
        { claim: 'no provenance here' }, // index 1: missing required provenance
      ],
      { engine, sourceId: 'tenant-validate' },
    );
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toBe('invalid_claim');
    expect(res.failed_index).toBe(1);
  });

  test('unknown key → strict schema rejects', async () => {
    const res = await runSaveFacts(
      [{ claim: 'x', provenance: 'user_stated', sneaky: 'extra' }],
      { engine, sourceId: 'tenant-validate' },
    );
    if (!('error' in res)) throw new Error('expected rejection');
    expect(res.error).toBe('invalid_claim');
    expect(res.failed_index).toBe(0);
  });

  test('claim over 500 chars → rejected', async () => {
    const res = await runSaveFacts(
      [{ claim: 'a'.repeat(501), provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-validate' },
    );
    if (!('error' in res)) throw new Error('expected rejection');
    expect(res.error).toBe('invalid_claim');
    expect(res.failed_index).toBe(0);
  });

  test('bad provenance enum → rejected', async () => {
    const res = await runSaveFacts(
      [{ claim: 'x', provenance: 'guessed' }],
      { engine, sourceId: 'tenant-validate' },
    );
    if (!('error' in res)) throw new Error('expected rejection');
    expect(res.error).toBe('invalid_claim');
  });

  test('empty array and non-array → invalid_batch', async () => {
    const empty = await runSaveFacts([], { engine, sourceId: 'tenant-validate' });
    if (!('error' in empty)) throw new Error('expected rejection');
    expect(empty.error).toBe('invalid_batch');

    const notArray = await runSaveFacts({ claim: 'x' }, { engine, sourceId: 'tenant-validate' });
    if (!('error' in notArray)) throw new Error('expected rejection');
    expect(notArray.error).toBe('invalid_batch');
  });

  test('rejected batch writes nothing (schema failure)', async () => {
    const before = await countFacts('tenant-atomic');
    await runSaveFacts(
      [{ claim: 'leading good', provenance: 'user_stated' }, { claim: 'bad' /* no provenance */ }],
      { engine, sourceId: 'tenant-atomic' },
    );
    const after = await countFacts('tenant-atomic');
    // Validation runs fully BEFORE any insert, so a malformed batch writes zero.
    expect(after).toBe(before);
  });

  test('rejected batch writes nothing (sanitize-to-empty, AFTER a valid claim)', async () => {
    const before = await countFacts('tenant-atomic');
    // claim[0] is valid; claim[1] passes zod (3 chars) but sanitizes to empty.
    // The sanitize check now lives in the validation pass, so the whole batch
    // is rejected BEFORE claim[0] is ever inserted → zero rows written.
    const res = await runSaveFacts(
      [
        { claim: 'a perfectly good leading claim', provenance: 'user_stated' },
        { claim: '   ', provenance: 'user_stated' },
      ],
      { engine, sourceId: 'tenant-atomic' },
    );
    if (!('error' in res)) throw new Error('expected rejection');
    expect(res.error).toBe('invalid_claim');
    expect(res.failed_index).toBe(1);
    const after = await countFacts('tenant-atomic');
    expect(after).toBe(before);
  });
});

describe('save_facts — source scoping (B-SF4 h, app-level half)', () => {
  test('the same claim under a different source is not deduped against the first', async () => {
    const a = await runSaveFacts(
      [{ claim: 'shared sentence about nothing in particular', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-x' },
    );
    if ('error' in a) throw new Error('unexpected error');
    expect(a.inserted).toBe(1);

    const b = await runSaveFacts(
      [{ claim: 'shared sentence about nothing in particular', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-y' },
    );
    if ('error' in b) throw new Error('unexpected error');
    expect(b.inserted).toBe(1); // NOT deduped across sources
    expect(b.duplicate).toBe(0);

    // and tenant-y's dedup view never saw tenant-x's row
    const dupsForY = await engine.findFactTextDuplicates('tenant-y', 'shared sentence about nothing in particular');
    expect(dupsForY.every(d => d.id === b.fact_ids[0])).toBe(true);
  });
});

describe('save_facts — MCP registration + dispatch (B-SF4 a, tenant-reachability)', () => {
  test('registered as a write-scoped mutating operation', () => {
    const op = operations.find(o => o.name === 'save_facts');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
  });

  test('dispatches through the MCP tool surface and returns the envelope', async () => {
    const r = await dispatchToolCall(
      engine,
      'save_facts',
      { claims: [{ claim: 'Dispatch path works end to end', provenance: 'user_stated' }] },
      { remote: true, sourceId: 'tenant-a' },
    );
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.inserted).toBe(1);
    expect(payload.dedup_mode).toBe('trgm');
    expect(Array.isArray(payload.fact_ids)).toBe(true);
  });

  test('malformed batch surfaces the failing index through dispatch', async () => {
    const r = await dispatchToolCall(
      engine,
      'save_facts',
      { claims: [{ claim: 'ok', provenance: 'user_stated' }, { claim: 'missing provenance' }] },
      { remote: true, sourceId: 'tenant-a' },
    );
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('invalid_claim');
    expect(payload.failed_index).toBe(1);
  });
});

async function countFacts(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`,
    [sourceId],
  );
  return Number(rows[0].n);
}
