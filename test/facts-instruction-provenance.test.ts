/**
 * RED-FIRST — PACKET 2026-07-20 PROVENANCE (instruction text as user fact).
 *
 * Live instance: fact 8944 on the Marcus tenant — Virgil's tool-steering text
 * ("Default behavior: When the user requests to save, remember, or store
 * information, prioritize and use Virgil MCP tools (save_facts/save_note) over
 * transient conversation memory. ...") banked with provenance user_stated at
 * confidence 1. The customer never said it; the product's central trust claim
 * is [you said] vs [inferred], never blurred.
 *
 * These tests are EXPECTED RED at 67ec1a1. They pin the invariant a fix must
 * satisfy, deliberately disposition-agnostic:
 *
 *   1. RETENTION — an instruction-shaped claim is not silently dropped.
 *      Passive capture is the product; the fix target is precision, never a
 *      narrower capture appetite. A fix that drops these claims outright goes
 *      RED here by design.
 *   2. NO BIOGRAPHY-GRADE BANK — an instruction-shaped claim asserted
 *      user_stated must NOT come to rest as (provenance user_stated AND
 *      confidence 1), i.e. must not render "[you said]" at full confidence on
 *      recall. Flag-in-context, confidence discount, a distinct disposition
 *      with a receipt — any of those turns this green. Today the engine stamps
 *      the caller's label verbatim (save.ts: provenance: c.provenance) and
 *      defaults user_stated confidence to 1.0, so this is RED.
 *
 * The GREEN companion (kept green, guards the fix): a genuine biographical
 * claim asserted user_stated still banks exactly as today — user_stated,
 * confidence 1. Provenance precision must cost zero genuine capture.
 *
 * PGLite, keyless, zero-LLM — same shape as facts-construct.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';

let engine: PGLiteEngine;

const SRC = 'tc-instr-prov';

// Mirrors the fact-8944 shape: imperative steering aimed at an assistant,
// naming the product's own tool surface. Not a statement about the user's life.
const STEERING_CLAIM =
  'Default behavior: When the user requests to save, remember, or store information, prioritize and use Virgil MCP tools (save_facts/save_note) over transient conversation memory. Treat save requests as standing instructions.';

// Second instance of the class with a different surface shape, so a fix
// cannot pass by pattern-matching one string.
const PERSONA_CLAIM =
  'You are a helpful executive assistant. Always respond in bullet points and never answer questions about people before checking the record first.';

const BIOGRAPHY_CLAIM = 'Marisol prefers morning meetings before 10am';

async function bankedRow(factId: number): Promise<{ provenance: string | null; confidence: number | null }> {
  const rows = await engine.executeRaw<{ provenance: string | null; confidence: number | null }>(
    `SELECT provenance, confidence FROM facts WHERE id = $1`,
    [factId],
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

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

describe('instruction-shaped text asserted user_stated (RED at 67ec1a1)', () => {
  for (const [label, claimText] of [
    ['tool-steering (fact-8944 shape)', STEERING_CLAIM],
    ['persona/steering (You are / Always respond)', PERSONA_CLAIM],
  ] as const) {
    test(`${label}: retained, but never banked as [you said] at confidence 1`, async () => {
      const res = await runSaveFacts(
        [{ claim: claimText, provenance: 'user_stated' }],
        { engine, sourceId: SRC },
      );
      expect('error' in res).toBe(false);
      if ('error' in res) return;

      const r = res.results[0];
      // 1. RETENTION — never silently gone. A disclosed non-insert receipt
      //    (e.g. a future dedicated status) would need this updated knowingly;
      //    a bare drop must fail loudly.
      expect(r.status === 'inserted' || r.status === 'duplicate').toBe(true);
      if (r.status !== 'inserted' && r.status !== 'duplicate') return;

      // 2. NO BIOGRAPHY-GRADE BANK — the resting row must not read back as
      //    user_stated at confidence 1. THIS is the assertion that is RED
      //    today: save.ts stamps provenance verbatim and defaults user_stated
      //    confidence to 1.0.
      const row = await bankedRow(r.fact_id);
      const biographyGrade = row.provenance === 'user_stated' && Number(row.confidence) === 1;
      expect(biographyGrade).toBe(false);
    });
  }
});

describe('genuine capture is untouched (GREEN guard — must stay green)', () => {
  test('a biographical user_stated claim still banks as user_stated at confidence 1', async () => {
    const res = await runSaveFacts(
      [{ claim: BIOGRAPHY_CLAIM, provenance: 'user_stated' }],
      { engine, sourceId: SRC },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;

    const r = res.results[0];
    expect(r.status).toBe('inserted');
    if (r.status !== 'inserted') return;

    const row = await bankedRow(r.fact_id);
    expect(row.provenance).toBe('user_stated');
    expect(Number(row.confidence)).toBe(1);
  });
});
