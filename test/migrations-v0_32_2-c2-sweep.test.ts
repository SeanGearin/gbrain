/**
 * C2 — v0_32_2 phase-B sweep must not resurrect expired/superseded
 * rows or convert client-authored rows to fence-backed.
 *
 * The pre-fix sweep selects `WHERE row_num IS NULL` with no dead-row
 * or client_authored filter, so:
 *   (1) a db_only supersession (durable:true) is rendered onto the
 *       fence UN-struck and resurrected ACTIVE by the next reconcile —
 *       the chain destroyed, `supersedeFactDurably`'s durability
 *       contract falsified by a supported, re-runnable migration;
 *   (2) deliberately fence-less `save_facts` rows (client_authored)
 *       are converted to fence-backed, and the next reconcile re-mints
 *       their primary keys — invalidating every client-held fact id.
 *
 * RED-FIRST inventory (all 6 FAIL at f15c468, each substantively):
 *   - "db_only supersession survives…"     ACTIVE=[CFO, CEO] resurrection
 *   - "client-authored row is not swept…"  held id re-minted → undefined
 *   - "dead legacy rows are skipped…"      fenced=4 where truth is 1
 *   - "dry-run equals write on a mixed…"   "would fence 6", no exclusion
 *     disclosure (the pre-fix count-equality itself held at 6==6 — both
 *     paths over-swept identically; the parity assertion's standing role
 *     is keeping them from drifting APART after the narrowing)
 *   - "no-local-path parity"               dry-run "would fence 1" while
 *     the write performed 0 (pre-existing lying-count, same class)
 *   - "degrades when client_authored absent" "would fence 2" counted the
 *     dead row on the old schema (phase A floors at v51; client_authored
 *     only exists from v93/v114; expired_at/superseded_by born at v45)
 *
 * Post-adversary hardening (red against 53598c6, the first C2 commit,
 * not f15c468): "probe failure fails CLOSED" (the probe's catch used to
 * swallow transport errors and proceed WITHOUT the client filter — the
 * exact C2 class on a healthy-column schema) and "empty-string
 * local_path" (dry-run counted '' sources as writable while the write
 * path skips any falsy local_path).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v0_32_2, __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { supersedeFactDurably } from '../src/core/facts/supersede.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'mig-c2-sweep-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const DRY_OPTS = { ...OPTS, dryRun: true };

async function putPage(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    title,
    type: 'person',
    compiled_truth: `# ${title}\n\nBody.\n`,
    frontmatter: {},
    timeline: '',
  });
}

interface SeedInput {
  entity_slug: string | null;
  fact: string;
  client_authored?: boolean;
  source_id?: string;
}

async function seedFact(input: SeedInput): Promise<number> {
  const res = await engine.insertFact(
    {
      fact: input.fact,
      entity_slug: input.entity_slug,
      source: input.client_authored ? 'mcp:save_facts' : 'mcp:put_page',
      ...(input.client_authored ? { client_authored: true } : {}),
    },
    { source_id: input.source_id ?? 'default' },
  );
  return res.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rawFact(id: number): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `SELECT id, fact, expired_at, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function activeFacts(slug: string): Promise<string[]> {
  const rows = await engine.listFactsByEntity('default', slug);
  return rows.map(f => f.fact);
}

describe('C2 keystone — db_only supersession survives phase B + reconcile', () => {
  test('db_only supersession is not resurrected and the chain survives with stable ids', async () => {
    // The verifier's live repro, end-to-end through the production path.
    const correction = await seedFact({
      entity_slug: 'people/reggie', fact: 'Reggie is CEO', client_authored: true,
    });
    const old = await seedFact({
      entity_slug: 'people/reggie', fact: 'Reggie is CFO', client_authored: true,
    });

    const sup = await supersedeFactDurably(engine, old, { supersededByFactId: correction, sourceId: 'default' });
    expect(sup.applied).toBe(true);
    expect(sup.path).toBe('db_only');
    expect(sup.durable).toBe(true);

    await putPage('people/reggie', 'Reggie');

    const b = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(b.status).toBe('complete');

    const r = await runExtractFacts(engine, { slugs: ['people/reggie'] });
    expect(r.guardTriggered).toBe(false);

    // The durability contract: the superseded claim must NOT be active.
    const active = await activeFacts('people/reggie');
    expect(active).toContain('Reggie is CEO');
    expect(active).not.toContain('Reggie is CFO');

    // The chain survives under the ORIGINAL ids — nothing re-minted.
    const oldRow = await rawFact(old);
    expect(oldRow).toBeDefined();
    expect(oldRow.expired_at).not.toBeNull();
    expect(Number(oldRow.superseded_by)).toBe(correction);
    const newRow = await rawFact(correction);
    expect(newRow).toBeDefined();
    expect(newRow.expired_at).toBeNull();
  });
});

describe('C2 keystone — client_authored rows are never swept', () => {
  test('client-authored row is not swept and its id is stable across phase B + reconcile', async () => {
    const held = await seedFact({
      entity_slug: 'people/nia', fact: 'Client-held claim about Nia', client_authored: true,
    });
    await putPage('people/nia', 'Nia');

    const b = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(b.status).toBe('complete');

    const r = await runExtractFacts(engine, { slugs: ['people/nia'] });
    expect(r.guardTriggered).toBe(false);

    // The id the client holds must still resolve to the same live row,
    // still deliberately fence-less.
    const row = await rawFact(held);
    expect(row).toBeDefined();
    expect(row.fact).toBe('Client-held claim about Nia');
    expect(row.row_num).toBeNull();
    expect(row.source_markdown_slug).toBeNull();
    expect(row.expired_at).toBeNull();

    // And the claim never landed on the disk fence.
    const pagePath = join(brainDir, 'people/nia.md');
    if (existsSync(pagePath)) {
      expect(readFileSync(pagePath, 'utf-8')).not.toContain('Client-held claim about Nia');
    }
  });
});

describe('C2 — dead legacy rows are skipped, stay intact, and do not freeze reconcile', () => {
  test('dead legacy rows are skipped by the sweep and not resurrected; reconcile still runs', async () => {
    // One page, four DB rows: a live legacy row (the only legitimate
    // sweep target), a forget-shaped dead row (expired_at only), a
    // superseded dead row chained to a client-authored successor.
    const live = await seedFact({ entity_slug: 'people/zed', fact: 'Zed lives in Lisbon' });
    const deadForgot = await seedFact({ entity_slug: 'people/zed', fact: 'Zed lives in Berlin' });
    expect(await engine.expireFact(deadForgot)).toBe(true);
    const successor = await seedFact({
      entity_slug: 'people/zed', fact: 'Zed is CTO', client_authored: true,
    });
    const deadSuper = await seedFact({ entity_slug: 'people/zed', fact: 'Zed is CFO' });
    expect(await engine.expireFact(deadSuper, { supersededBy: successor })).toBe(true);

    await putPage('people/zed', 'Zed');

    const b = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(b.status).toBe('complete');
    // Only the live legacy row is fenced; dead + client rows are excluded.
    expect(b.detail).toContain('fenced=1');

    // The live row genuinely joined the fence. (Checked BEFORE the
    // reconcile: fence-backed ids are re-minted by the wipe+re-insert,
    // so its original id is only addressable until then. The dead rows
    // below are checked AFTER — their ids are stable precisely because
    // the sweep skipped them.)
    const lv = await rawFact(live);
    expect(lv.row_num).not.toBeNull();
    expect(lv.source_markdown_slug).toBe('people/zed');

    // A skipped dead row is NOT "pending backfill" — it must never
    // freeze fence reconciliation (the B7-freeze class, dead-row
    // flavor).
    const r = await runExtractFacts(engine, { slugs: ['people/zed'] });
    expect(r.guardTriggered).toBe(false);

    const active = await activeFacts('people/zed');
    expect(active).toContain('Zed lives in Lisbon');
    expect(active).toContain('Zed is CTO');
    expect(active).not.toContain('Zed lives in Berlin');
    expect(active).not.toContain('Zed is CFO');

    // Dead rows keep their exact custody: ids, timestamps, chain — and
    // stay out of the fence keyspace (row_num NULL forever, like the
    // NULL-entity_slug legacy class).
    const df = await rawFact(deadForgot);
    expect(df.row_num).toBeNull();
    expect(df.expired_at).not.toBeNull();
    const ds = await rawFact(deadSuper);
    expect(ds.row_num).toBeNull();
    expect(ds.expired_at).not.toBeNull();
    expect(Number(ds.superseded_by)).toBe(successor);
  });
});

describe('C2 — dry-run/write parity (the preview must not lie)', () => {
  test('dry-run count equals what the write path performs on a mixed corpus, and discloses exclusions', async () => {
    // Mixed corpus: 2 normal legacy, 1 NULL-entity, 1 dead-expired,
    // 1 dead-superseded, 1 client live, 1 client dead.
    await seedFact({ entity_slug: 'people/alice', fact: 'Alice founded Acme' });
    await seedFact({ entity_slug: 'people/bob', fact: 'Bob met Alice at YC' });
    await seedFact({ entity_slug: null, fact: 'Unparented claim' });
    const deadExpired = await seedFact({ entity_slug: 'people/alice', fact: 'Alice lives in Tokyo' });
    expect(await engine.expireFact(deadExpired)).toBe(true);
    const clientLive = await seedFact({
      entity_slug: 'people/bob', fact: 'Client claim about Bob', client_authored: true,
    });
    const deadSuper = await seedFact({ entity_slug: 'people/bob', fact: 'Bob is CFO' });
    expect(await engine.expireFact(deadSuper, { supersededBy: clientLive })).toBe(true);
    const clientDead = await seedFact({
      entity_slug: 'people/alice', fact: 'Client claim now dead', client_authored: true,
    });
    expect(await engine.expireFact(clientDead)).toBe(true);

    const dry = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(dry.status).toBe('skipped');
    const predicted = /would fence (\d+) rows/.exec(dry.detail ?? '');
    expect(predicted).not.toBeNull();

    // The operator must see WHY the number moved: 3 dead (2 expired +
    // 1 superseded-dead among them counted once each), 1 client-live
    // excluded. NULL-entity stays its own disclosed class.
    expect(dry.detail).toContain('1 unfenceable');
    expect(dry.detail).toContain('3 expired/superseded');
    expect(dry.detail).toContain('1 client-authored');

    const write = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(write.status).toBe('complete');
    const performed = /fenced=(\d+)/.exec(write.detail ?? '');
    expect(performed).not.toBeNull();

    // THE parity assertion: preview == performance. (Pre-fix both sides
    // agree at 6 — over-sweeping identically; post-fix both sides must
    // agree at 2. What this pins is that they can never drift apart.)
    expect(Number(performed![1])).toBe(Number(predicted![1]));
    expect(Number(performed![1])).toBe(2);
    expect(write.detail).toContain('excluded_dead=3');
    expect(write.detail).toContain('excluded_client=1');
  });

  test('no-local-path rows are excluded from the dry-run count exactly as the write path skips them', async () => {
    // Pre-fix red: the dry-run said "would fence 1" while the write
    // path performed 0 (skipped_no_local_path) — the same lying-count
    // class, pre-existing. The shared predicate closes it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seedFact({ entity_slug: 'people/alice', fact: 'Unwritable claim' });

    const dry = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(dry.detail).toContain('would fence 0 rows');
    expect(dry.detail).toContain('1 skipped (source has no local_path)');

    const write = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(write.status).toBe('complete');
    expect(write.detail).toContain('fenced=0');
    expect(write.detail).toContain('skipped_no_local_path=1');
  });

  test('empty-string local_path previews exactly as the write path skips it', async () => {
    // The write path treats any FALSY local_path as unwritable; the
    // preview must count '' the same as NULL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = '' WHERE id = 'default'`);
    await seedFact({ entity_slug: 'people/alice', fact: 'Unwritable claim' });

    const dry = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(dry.detail).toContain('would fence 0 rows');
    expect(dry.detail).toContain('1 skipped (source has no local_path)');

    const write = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(write.status).toBe('complete');
    expect(write.detail).toContain('fenced=0');
    expect(write.detail).toContain('skipped_no_local_path=1');
  });
});

describe('C2 — probe failure fails CLOSED', () => {
  test('a failing client_authored probe fails the phase instead of silently sweeping client rows', async () => {
    const held = await seedFact({
      entity_slug: 'people/nia', fact: 'Client-held claim about Nia', client_authored: true,
    });

    // Simulate a transient infrastructure failure on the probe only —
    // everything else about the engine works. A swallowed probe error
    // would omit the client filter and sweep the row (the exact C2
    // class); the phase must fail closed instead.
    const probeFailing = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return (sql: string, params?: unknown[]) => {
            if (sql.includes('information_schema')) {
              throw new Error('probe transport failure');
            }
            return target.executeRaw(sql, params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PGLiteEngine;

    const dry = await __testing.phaseBFenceFacts(probeFailing, DRY_OPTS);
    expect(dry.status).toBe('failed');
    expect(dry.detail).toContain('probe transport failure');

    const write = await __testing.phaseBFenceFacts(probeFailing, OPTS);
    expect(write.status).toBe('failed');
    expect(write.detail).toContain('probe transport failure');

    // The client row was never touched.
    const row = await rawFact(held);
    expect(row.row_num).toBeNull();
    expect(row.source_markdown_slug).toBeNull();
  });
});

describe('C2 — pre-schema-floor safety (client_authored absent)', () => {
  // Phase A floors at v51; client_authored only exists from v93 (prod
  // lineage) / v114 (master lineage). A DEDICATED engine simulates the
  // in-between schema by dropping the column initSchema created — the
  // shared file engine must never carry that schema mutation
  // (resetPgliteState deliberately preserves schema).
  let oldEngine: PGLiteEngine;
  let oldBrainDir: string;

  beforeAll(async () => {
    oldEngine = new PGLiteEngine();
    await oldEngine.connect({});
    await oldEngine.initSchema();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (oldEngine as any).db.query('ALTER TABLE facts DROP COLUMN client_authored');
    oldBrainDir = mkdtempSync(join(tmpdir(), 'mig-c2-floor-'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (oldEngine as any).db.query(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [oldBrainDir],
    );
  });

  afterAll(async () => {
    await oldEngine.disconnect();
    try { rmSync(oldBrainDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('phase B degrades safely when the client_authored column does not exist (schema v51..v92)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (oldEngine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/old', 'Pre-v93 live claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dead = await (oldEngine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at)
       VALUES ('default', 'people/old', 'Pre-v93 dead claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0, now())
       RETURNING id`,
    );

    const dry = await __testing.phaseBFenceFacts(oldEngine, DRY_OPTS);
    expect(dry.status).toBe('skipped');
    expect(dry.detail).toContain('would fence 1 rows');

    const write = await __testing.phaseBFenceFacts(oldEngine, OPTS);
    expect(write.status).toBe('complete');
    expect(write.detail).toContain('fenced=1');
    expect(write.detail).toContain('excluded_dead=1');

    // The dead row survived untouched even on the old schema
    // (expired_at/superseded_by predate the v51 floor — born with the
    // facts table at v45).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (oldEngine as any).db.query(
      'SELECT row_num, expired_at FROM facts WHERE id = $1', [dead.rows[0].id],
    );
    expect(row.rows[0].row_num).toBeNull();
    expect(row.rows[0].expired_at).not.toBeNull();
  });
});
