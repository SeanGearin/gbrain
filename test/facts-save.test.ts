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
  'tenant-entity', 'tenant-rel', 'tenant-restricted', 'tenant-seed',
  'tenant-sup-insert', 'tenant-sup-dedup', 'tenant-sup-self', 'tenant-sup-e2e',
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
    // v1.1 recall-miss fix + graph construct: a single-person claim gets its
    // subject mapped to entity_slug at save time. tenant-a has no pages, so the
    // resolver falls through to the same typed slug the graph construct mints.
    expect(row.entity_slug).toBe('people/priya');
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

describe('save_facts — entity_slug at save time (v1.1 recall-miss fix)', () => {
  // The owner caller shape from facts-recall-owner-visibility.test.ts:
  // ctx.auth.sourceId is the owner signal the recall carve-out keys on, so a
  // remote owner reads back its own private rows (save_facts writes private).
  function ownerCaller(sourceId: string) {
    return {
      remote: true,
      sourceId,
      auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId },
    };
  }

  async function recallByEntity(sourceId: string, entity: string): Promise<number[]> {
    const r = await dispatchToolCall(engine, 'recall', { entity }, ownerCaller(sourceId));
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    return (payload.facts as Array<{ id: number }>).map(f => f.id);
  }

  test('ACCEPTANCE: save a claim about a known subject → entity recall through the real dispatch path returns it', async () => {
    // A canonical page exists for the subject — the resolver must land the
    // fact on it (fuzzy title match), not on a slugified surface form.
    await engine.putPage(
      'people/priya-sharma',
      { type: 'note', title: 'Priya Sharma', compiled_truth: 'Priya Sharma — test person.', frontmatter: {} },
      { sourceId: 'tenant-entity' },
    );

    const saved = await runSaveFacts(
      [{ claim: 'Priya Sharma is allergic to penicillin', provenance: 'user_stated', people: ['Priya Sharma'] }],
      { engine, sourceId: 'tenant-entity' },
    );
    if ('error' in saved) throw new Error('unexpected validation error');
    expect(saved.inserted).toBe(1);
    const factId = saved.fact_ids[0];

    const row = await readFactRaw(factId);
    expect(row.entity_slug).toBe('people/priya-sharma');

    // Round-trip BY ENTITY through dispatch — display name AND exact slug.
    expect(await recallByEntity('tenant-entity', 'Priya Sharma')).toContain(factId);
    expect(await recallByEntity('tenant-entity', 'people/priya-sharma')).toContain(factId);
  });

  test('no matching page: typed graph fallback still round-trips (write and read share the resolver)', async () => {
    const saved = await runSaveFacts(
      [{ claim: 'Zinnia moved to Lisbon in May', provenance: 'user_stated', people: ['Zinnia'] }],
      { engine, sourceId: 'tenant-entity' },
    );
    if ('error' in saved) throw new Error('unexpected validation error');
    const factId = saved.fact_ids[0];

    const row = await readFactRaw(factId);
    expect(row.entity_slug).toBe('people/zinnia');

    expect(await recallByEntity('tenant-entity', 'Zinnia')).toContain(factId);
  });

  test('person-subject claim anchors to the leading person; pure company claim to the company', async () => {
    // Carla is both the only person AND the grammatical subject ("Carla joined …").
    const person = await runSaveFacts(
      [{ claim: 'Carla joined Acme Corp as CTO', provenance: 'user_stated', people: ['Carla'], entities: ['Acme Corp'] }],
      { engine, sourceId: 'tenant-entity' },
    );
    if ('error' in person) throw new Error('unexpected validation error');
    expect((await readFactRaw(person.fact_ids[0])).entity_slug).toBe('people/carla');

    const entity = await runSaveFacts(
      [{ claim: 'Acme Corp raised a Series B', provenance: 'user_stated', entities: ['Acme Corp'] }],
      { engine, sourceId: 'tenant-entity' },
    );
    if ('error' in entity) throw new Error('unexpected validation error');
    expect((await readFactRaw(entity.fact_ids[0])).entity_slug).toBe('companies/acme-corp');
  });

  test('relationship-class claim anchors to the leading (principal) subject, not NULL; the other party stays recoverable', async () => {
    // Leading-mention rule: "Ann introduced Bob …" is principally about Ann's
    // action. The prior rule dropped 2+-person claims to NULL — the bug that put
    // every multi-person Boltline claim into the recall/search black hole. Now
    // the claim anchors to its grammatical subject and Bob remains recoverable
    // via `context` AND a co-occurrence graph edge.
    const saved = await runSaveFacts(
      [{ claim: 'Ann introduced Bob to the team', provenance: 'user_stated', people: ['Ann', 'Bob'] }],
      { engine, sourceId: 'tenant-rel' },
    );
    if ('error' in saved) throw new Error('unexpected validation error');
    expect(saved.inserted).toBe(1);

    const row = await readFactRaw(saved.fact_ids[0]);
    expect(row.entity_slug).toBe('people/ann');
    // The co-mentioned party stays recoverable via context even though the
    // single entity_slug column can only name the principal subject.
    expect(row.context).toContain('Ann');
    expect(row.context).toContain('Bob');
  });

  test('no subject at all stays NULL (unchanged baseline)', async () => {
    const saved = await runSaveFacts(
      [{ claim: 'The kitchen renovation budget is 40k', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-rel' },
    );
    if ('error' in saved) throw new Error('unexpected validation error');
    expect((await readFactRaw(saved.fact_ids[0])).entity_slug).toBeNull();
  });
});

describe('save_facts — leading-mention primary-subject (Boltline regression)', () => {
  // The exact failure the entity_slug v1.x fix targets. These claims are copied
  // verbatim from the Marcus demo seed packet (Batches 3/4/7). Under the prior
  // "person wins / else NULL" rule EVERY one anchored to a co-mentioned person
  // or to NULL — never to companies/boltline — so search_brain "Boltline"
  // returned nothing of Boltline's own facts. Leading mention anchors a claim
  // to whichever entity (person or company) the claim text names FIRST.
  //
  // No pages pre-exist in tenant-seed, so the resolver falls to the typed
  // graph-fallback slug — the SAME slug constructGraphFromClaim mints — which is
  // exactly the production cold-tenant ordering (facts resolved before the page
  // graph is enriched).

  async function slugOf(claim: object): Promise<string | null> {
    const saved = await runSaveFacts([{ provenance: 'user_stated', ...claim }], {
      engine,
      sourceId: 'tenant-seed',
    });
    if ('error' in saved) throw new Error(`unexpected validation error: ${saved.detail}`);
    return (await readFactRaw(saved.fact_ids[0])).entity_slug;
  }

  test('company-leading claim with a co-mentioned person → companies/boltline (the core fix)', async () => {
    expect(
      await slugOf({
        claim:
          "Boltline is trying to land its first league partnership and wants Marcus's help structuring the deal without overpaying.",
        people: ['Reggie Salas', 'Marcus Vale'],
        entities: ['Boltline'],
      }),
    ).toBe('companies/boltline');
  });

  test('"The Boltline engagement is one of Marcus\'s …" → companies/boltline (company leads after an article)', async () => {
    expect(
      await slugOf({
        claim: "The Boltline engagement is one of Marcus's two active advisory deals.",
        people: ['Marcus Vale'],
        entities: ['Boltline'],
      }),
    ).toBe('companies/boltline');
  });

  test('"Boltline is Reggie Salas\'s … startup …" → companies/boltline (company first, two people listed)', async () => {
    expect(
      await slugOf({
        claim: "Boltline is Reggie Salas's daily-fantasy and betting startup and Marcus's first active advisory deal.",
        people: ['Reggie Salas', 'Marcus Vale'],
        entities: ['Boltline'],
      }),
    ).toBe('companies/boltline');
  });

  test('person-leading Boltline claim still anchors to the person (defensible) — "Reggie Salas is the founder of Boltline"', async () => {
    expect(
      await slugOf({
        claim: 'Reggie Salas is the founder of Boltline, a daily-fantasy and sports-betting upstart.',
        people: ['Reggie Salas'],
        entities: ['Boltline'],
      }),
    ).toBe('people/reggie-salas');
  });

  test('first-name-only claim text matches a full-name surface form → people/reggie-salas', async () => {
    // people[]="Reggie Salas" but the text says only "Reggie" — token matching
    // is what makes leading mention fire on the real seed corpus.
    expect(
      await slugOf({
        claim: 'Reggie is sitting on the proposal because budget approval stalled internally at Boltline.',
        people: ['Reggie Salas'],
        entities: ['Boltline'],
      }),
    ).toBe('people/reggie-salas');
  });

  test('framing decides person-vs-company: "Selene is CMO at Strider" → person; "Strider is a giant …" → company', async () => {
    expect(
      await slugOf({
        claim: 'Selene Marchetti is the CMO at Strider, the sportswear giant from the Halftime Capsule.',
        people: ['Selene Marchetti'],
        entities: ['Strider', 'Halftime Capsule'],
      }),
    ).toBe('people/selene-marchetti');

    expect(
      await slugOf({
        claim: "Strider is a sportswear giant, partner on the Halftime Capsule and Selene Marchetti's employer.",
        people: ['Selene Marchetti'],
        entities: ['Strider', 'Halftime Capsule'],
      }),
    ).toBe('companies/strider');
  });

  test('person-subject self facts stay on the person — "Marcus is now building Sightline"', async () => {
    expect(
      await slugOf({
        claim: 'Marcus is now building Sightline, a deal-intelligence AI for sports and entertainment partnerships.',
        people: ['Marcus Vale'],
        entities: ['Sightline'],
      }),
    ).toBe('people/marcus-vale');
  });

  test('pure-company supporting claim with no people → companies/meridian-line-ventures', async () => {
    expect(
      await slugOf({
        claim: 'Meridian Line Ventures is a sports and consumer focused venture fund.',
        people: [],
        entities: ['Meridian Line Ventures'],
      }),
    ).toBe('companies/meridian-line-ventures');
  });

  test('word-boundary safety: a short surface token does not match inside an unrelated word', async () => {
    // "Eli" must not match inside "Selene"; the leading subject is Selene.
    expect(
      await slugOf({
        claim: 'Selene mentioned that Eli would attend.',
        people: ['Selene Marchetti', 'Eli Vale'],
        entities: [],
      }),
    ).toBe('people/selene-marchetti');
  });

  test('no surface form present in text → falls back to the first person (never NULL while a candidate exists)', async () => {
    expect(
      await slugOf({
        claim: 'He closed the deal yesterday.',
        people: ['Marcus Vale'],
        entities: ['Sightline'],
      }),
    ).toBe('people/marcus-vale');
  });

  test('an over-long (>200 char) leading surface is skipped, not anchored — a valid short candidate still wins (never NULL)', async () => {
    // Adversarial: a garbage 250-char "entity" mentioned earliest must NOT force
    // the claim to NULL; the real person co-candidate anchors it. ClaimSchema
    // caps claim TEXT at 500 but not per-entity length, so this is reachable.
    const longName = 'X'.repeat(250);
    expect(
      await slugOf({
        claim: `The ${'X'.repeat(250)} initiative is led by Alice.`,
        people: ['Alice'],
        entities: [longName],
      }),
    ).toBe('people/alice');
  });
});

describe('save_facts — restricted-data scrub (drop one, keep the batch)', () => {
  test('drops a Luhn-valid card claim, keeps the clean claims, counts it in `dropped`', async () => {
    const res = await runSaveFacts(
      [
        { claim: 'Dana prefers async standups', provenance: 'user_stated' },
        { claim: 'Dana card 4111 1111 1111 1111', provenance: 'user_stated' },
        { claim: 'Dana is based in Denver', provenance: 'user_stated' },
      ],
      { engine, sourceId: 'tenant-restricted' },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    // Card claim dropped; the other two saved. The batch is NOT rejected.
    expect(res.inserted).toBe(2);
    expect(res.dropped).toBe(1);
    expect(res.fact_ids).toHaveLength(2);
    // Only the two clean rows landed in the table; the card value never persisted.
    expect(await countFacts('tenant-restricted')).toBe(2);
    const texts = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = $1`,
      ['tenant-restricted'],
    );
    expect(texts.some(t => t.fact.includes('4111'))).toBe(false);
    expect(texts.some(t => t.fact.includes('async standups'))).toBe(true);
  });

  test('drops a formatted SSN claim', async () => {
    const res = await runSaveFacts(
      [{ claim: 'his ssn is 123-45-6789', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-restricted' },
    );
    if ('error' in res) throw new Error('unexpected validation error');
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(1);
    expect(res.fact_ids).toHaveLength(0);
  });

  test('a bare 9-digit invoice number with no SSN context is SAVED', async () => {
    const res = await runSaveFacts(
      [{ claim: 'invoice 123456789 is paid', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-restricted' },
    );
    if ('error' in res) throw new Error('unexpected validation error');
    expect(res.inserted).toBe(1);
    expect(res.dropped).toBe(0);
  });

  test('a batch that is entirely restricted returns inserted:0, dropped:N (not a batch error)', async () => {
    const res = await runSaveFacts(
      [
        { claim: 'sk-AbCd1234EfGh5678IjKl9012mnop', provenance: 'user_stated' },
        { claim: 'card 4111111111111111', provenance: 'user_stated' },
      ],
      { engine, sourceId: 'tenant-restricted' },
    );
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.inserted).toBe(0);
    expect(res.dropped).toBe(2);
  });

  test('clean batch reports dropped:0', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Dana likes hiking', provenance: 'user_stated' }],
      { engine, sourceId: 'tenant-restricted' },
    );
    if ('error' in res) throw new Error('unexpected validation error');
    expect(res.dropped).toBe(0);
  });

  test('the MCP save_facts op surfaces `dropped` in its payload', async () => {
    const r = await dispatchToolCall(
      engine,
      'save_facts',
      { claims: [{ claim: 'card 4111-1111-1111-1111', provenance: 'user_stated' }] },
      { remote: true, sourceId: 'tenant-restricted' },
    );
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.dropped).toBe(1);
    expect(payload.inserted).toBe(0);
  });
});

// B2 supersession state: expired_at + superseded_by are the observable proof a
// correction landed. Read them directly (they aren't on the reduced readFactRaw).
async function readSupersession(id: number): Promise<{
  expired_at: Date | null;
  superseded_by: number | null;
}> {
  const rows = await engine.executeRaw<{ expired_at: Date | string | null; superseded_by: number | string | null }>(
    `SELECT expired_at, superseded_by FROM facts WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return {
    expired_at: row.expired_at == null ? null : new Date(row.expired_at as string),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
  };
}

describe('save_facts — B2 supersedes (correction on the customer plane)', () => {
  test('insert path: a correction with `supersedes` atomically expires the target and links it to the new row', async () => {
    const old = await runSaveFacts(
      [{ claim: 'Dexter lives in Portland', provenance: 'user_stated', people: ['Dexter'] }],
      { engine, sourceId: 'tenant-sup-insert' },
    );
    if ('error' in old) throw new Error('unexpected validation error');
    expect(old.inserted).toBe(1);
    const oldId = old.fact_ids[0];

    // Lexically distinct correction so it never accidentally dedups — the
    // supersede link is explicit via the id, not inferred from text overlap.
    const corr = await runSaveFacts(
      [{ claim: 'Dexter relocated to Austin last month', provenance: 'user_stated', people: ['Dexter'], supersedes: oldId }],
      { engine, sourceId: 'tenant-sup-insert' },
    );
    if ('error' in corr) throw new Error('unexpected validation error');
    expect(corr.inserted).toBe(1);
    expect(corr.superseded).toBe(1);
    expect(corr.duplicate).toBe(0);
    expect(corr.dropped).toBe(0);
    const newId = corr.fact_ids[0];
    expect(newId).not.toBe(oldId);

    // Old row: expired + pointed at the replacement. New row: active.
    const oldState = await readSupersession(oldId);
    expect(oldState.expired_at).not.toBeNull();
    expect(oldState.superseded_by).toBe(newId);
    const newState = await readSupersession(newId);
    expect(newState.expired_at).toBeNull();
    expect(newState.superseded_by).toBeNull();
  });

  test('dedup path: duplicate+supersedes still applies the supersede (no new row, old row expired to the canonical dup)', async () => {
    // Old value, then the canonical corrected value as a normal save.
    const freePlan = await runSaveFacts(
      [{ claim: 'Nadia is on the Free plan', provenance: 'user_stated', people: ['Nadia'] }],
      { engine, sourceId: 'tenant-sup-dedup' },
    );
    if ('error' in freePlan) throw new Error('unexpected validation error');
    const freeId = freePlan.fact_ids[0];

    const proPlan = await runSaveFacts(
      [{ claim: 'Nadia is on the Pro plan', provenance: 'user_stated', people: ['Nadia'] }],
      { engine, sourceId: 'tenant-sup-dedup' },
    );
    if ('error' in proPlan) throw new Error('unexpected validation error');
    const proId = proPlan.fact_ids[0];

    const before = await countFacts('tenant-sup-dedup');

    // Re-send the canonical corrected value (a DUP of proId) but mark that it
    // supersedes the old free-plan fact. No new row; the supersede still lands.
    const corr = await runSaveFacts(
      [{ claim: 'Nadia is on the Pro plan', provenance: 'user_stated', people: ['Nadia'], supersedes: freeId }],
      { engine, sourceId: 'tenant-sup-dedup' },
    );
    if ('error' in corr) throw new Error('unexpected validation error');
    expect(corr.inserted).toBe(0);
    expect(corr.duplicate).toBe(1);
    expect(corr.superseded).toBe(1);
    expect(corr.fact_ids).toEqual([proId]);
    expect(await countFacts('tenant-sup-dedup')).toBe(before); // no new row

    const freeState = await readSupersession(freeId);
    expect(freeState.expired_at).not.toBeNull();
    expect(freeState.superseded_by).toBe(proId); // pointed at the canonical dup

    // Idempotent / honest no-op: re-applying against the now-expired target
    // does NOT re-count (expireFact returns false on expired_at IS NOT NULL).
    const again = await runSaveFacts(
      [{ claim: 'Nadia is on the Pro plan', provenance: 'user_stated', people: ['Nadia'], supersedes: freeId }],
      { engine, sourceId: 'tenant-sup-dedup' },
    );
    if ('error' in again) throw new Error('unexpected validation error');
    expect(again.superseded).toBe(0);
    expect(again.duplicate).toBe(1);
  });

  test('self-supersession is guarded: a dup that names its own matched row as `supersedes` does not expire it', async () => {
    const first = await runSaveFacts(
      [{ claim: 'Otto plays chess on Sundays', provenance: 'user_stated', people: ['Otto'] }],
      { engine, sourceId: 'tenant-sup-self' },
    );
    if ('error' in first) throw new Error('unexpected validation error');
    const id = first.fact_ids[0];

    const selfDup = await runSaveFacts(
      [{ claim: 'Otto plays chess on Sundays', provenance: 'user_stated', people: ['Otto'], supersedes: id }],
      { engine, sourceId: 'tenant-sup-self' },
    );
    if ('error' in selfDup) throw new Error('unexpected validation error');
    expect(selfDup.duplicate).toBe(1);
    expect(selfDup.superseded).toBe(0); // never supersede itself
    expect(selfDup.fact_ids).toEqual([id]);

    // The row is still active — not expired against itself.
    const state = await readSupersession(id);
    expect(state.expired_at).toBeNull();
    expect(state.superseded_by).toBeNull();
  });

  test('a plain save (no `supersedes`) reports superseded:0 and is otherwise unchanged', async () => {
    const res = await runSaveFacts(
      [{ claim: 'Percy prefers tea over coffee', provenance: 'user_stated', people: ['Percy'] }],
      { engine, sourceId: 'tenant-sup-insert' },
    );
    if ('error' in res) throw new Error('unexpected validation error');
    expect(res.inserted).toBe(1);
    expect(res.superseded).toBe(0);
  });

  test('supersedes must be a positive integer (schema rejects 0 / negative / float)', async () => {
    for (const bad of [0, -3, 2.5]) {
      const res = await runSaveFacts(
        [{ claim: 'x is y', provenance: 'user_stated', supersedes: bad }],
        { engine, sourceId: 'tenant-sup-insert' },
      );
      if (!('error' in res)) throw new Error(`expected rejection for supersedes=${bad}`);
      expect(res.error).toBe('invalid_claim');
      expect(res.failed_index).toBe(0);
    }
  });

  test('end to end through dispatch: save → correct → recall(supersessions) shows the chain, and payload carries `superseded`', async () => {
    // Owner caller so recall reads the source's own private rows back.
    const ownerCaller = {
      remote: true,
      sourceId: 'tenant-sup-e2e',
      auth: { token: 't', clientId: 'c', scopes: ['read', 'write'], sourceId: 'tenant-sup-e2e' },
    };

    const saved = await dispatchToolCall(
      engine,
      'save_facts',
      { claims: [{ claim: 'Wren works at Northwind', provenance: 'user_stated', people: ['Wren'] }] },
      ownerCaller,
    );
    const savedPayload = JSON.parse(saved.content[0].text);
    expect(savedPayload.inserted).toBe(1);
    expect(savedPayload.superseded).toBe(0);
    const oldId = savedPayload.fact_ids[0];

    const corrected = await dispatchToolCall(
      engine,
      'save_facts',
      { claims: [{ claim: 'Wren now works at Gale Systems', provenance: 'user_stated', people: ['Wren'], supersedes: oldId }] },
      ownerCaller,
    );
    const corrPayload = JSON.parse(corrected.content[0].text);
    expect(corrPayload.inserted).toBe(1);
    expect(corrPayload.superseded).toBe(1);
    const newId = corrPayload.fact_ids[0];

    // The supersession audit log (recall supersessions:true) surfaces the old
    // row with superseded_by → the new row. This is exactly Sean's on-deploy
    // verification path.
    const audit = await dispatchToolCall(
      engine,
      'recall',
      { supersessions: true },
      ownerCaller,
    );
    const auditPayload = JSON.parse(audit.content[0].text);
    const superseded = (auditPayload.facts as Array<{ id: number; superseded_by: number | null }>)
      .find(f => f.id === oldId);
    expect(superseded).toBeDefined();
    expect(superseded!.superseded_by).toBe(newId);
  });
});

async function countFacts(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1`,
    [sourceId],
  );
  return Number(rows[0].n);
}
