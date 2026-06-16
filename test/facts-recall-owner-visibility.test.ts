/**
 * B7 recall owner-visibility (engine pass 3) — the read rule that lets an owner
 * read their own private facts back through their own (remote) connector.
 *
 * Before this pass: recall forced visibility=['world'] for every remote caller,
 * while save_facts (and extract_facts) write visibility='private' — so a tenant
 * could write facts but recall returned EMPTY. The fix widens the predicate to
 * (visibility = 'world' OR source_id = ownerSourceId) for remote callers with a
 * resolved source scope; unscoped remote callers stay world-only verbatim; the
 * local CLI is unfiltered as before.
 *
 * Runs on PGLite (in-memory; no DSN). NOTE: PGLite's withSourceScope is a
 * pass-through (no RLS engine), so the cross-source test here exercises the
 * APP-LEVEL half (source_id scoping in the SQL); the RLS-policy half is the
 * deployed-Postgres box's job and is deliberately NOT exercised here.
 *
 * Maps to packet R-3: (1) owner read-back, (2) cross-source denial, (3) world
 * visibility unchanged + unscoped stays world-only.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSaveFacts } from '../src/core/facts/save.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

class RecordingScopeEngine extends PGLiteEngine {
  readonly sourceScopeCalls: string[] = [];

  async withSourceScope<T>(sourceId: string, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    this.sourceScopeCalls.push(sourceId);
    return super.withSourceScope(sourceId, fn);
  }
}

const SOURCES = ['tenant-x', 'tenant-y', 'default'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of SOURCES) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

// A token scoped to (i.e. owning) a source. ctx.auth.sourceId is the owner
// signal the recall carve-out keys on; ctx.sourceId is the query scope. In
// production serve-http sets both from the same token; we mirror that here.
function ownerCaller(sourceId: string) {
  return {
    remote: true,
    sourceId,
    auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId },
  };
}

async function recallFacts(opts: {
  remote: boolean;
  sourceId?: string;
  auth?: { token: string; clientId: string; scopes: string[]; sourceId?: string };
}): Promise<Array<{ fact: string; visibility: string }>> {
  const r = await dispatchToolCall(engine, 'recall', {}, opts);
  const payload = JSON.parse(r.content[0].text);
  return payload.facts as Array<{ fact: string; visibility: string }>;
}

describe('recall owner-visibility (R-3)', () => {
  test('(1) owner read-back — a remote owner sees their own private facts', async () => {
    // save_facts writes visibility='private'.
    const saved = await runSaveFacts(
      [
        { claim: 'Owner private fact alpha', provenance: 'user_stated' },
        { claim: 'Owner private fact beta', provenance: 'user_stated' },
      ],
      { engine, sourceId: 'tenant-x' },
    );
    if ('error' in saved) throw new Error('save failed');
    expect(saved.inserted).toBe(2);

    // Remote recall scoped to tenant-x → the private rows come back.
    const facts = await recallFacts(ownerCaller('tenant-x'));
    const texts = facts.map(f => f.fact);
    expect(texts).toContain('Owner private fact alpha');
    expect(texts).toContain('Owner private fact beta');
    // These are private rows surfacing to their owner — the whole point.
    const alpha = facts.find(f => f.fact === 'Owner private fact alpha');
    expect(alpha?.visibility).toBe('private');
  });

  test('(1b) owner also still sees world facts (carve-out did not hide world)', async () => {
    await engine.insertFact(
      { fact: 'Owner world fact epsilon', kind: 'fact', source: 'test', visibility: 'world' },
      { source_id: 'tenant-x' },
    );
    const texts = (await recallFacts(ownerCaller('tenant-x'))).map(f => f.fact);
    expect(texts).toContain('Owner world fact epsilon');
    expect(texts).toContain('Owner private fact alpha'); // and private, together
  });

  test('(2) cross-source denial — tenant-y does not see tenant-x private facts', async () => {
    const texts = (await recallFacts(ownerCaller('tenant-y'))).map(f => f.fact);
    expect(texts).not.toContain('Owner private fact alpha');
    expect(texts).not.toContain('Owner private fact beta');
    // app-level (source_id) half on PGLite; RLS-role half is the box's job.
  });

  test('(3) unscoped remote caller stays world-only — world visible, private hidden', async () => {
    await engine.insertFact(
      { fact: 'Public world fact gamma', kind: 'fact', source: 'test', visibility: 'world' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'Hidden private fact delta', kind: 'fact', source: 'test', visibility: 'private' },
      { source_id: 'default' },
    );

    // No sourceId → ctx.sourceId undefined → handler queries 'default' with
    // ownerSourceId null → world-only predicate preserved verbatim.
    const texts = (await recallFacts({ remote: true })).map(f => f.fact);
    expect(texts).toContain('Public world fact gamma'); // world still visible
    expect(texts).not.toContain('Hidden private fact delta'); // private still hidden
  });

  test('(3b) the world-only path is unchanged for a SCOPED caller reading only world rows', async () => {
    // A scoped owner reading their own source still sees world rows (sanity:
    // the OR predicate is additive, never subtractive).
    const texts = (await recallFacts(ownerCaller('tenant-x'))).map(f => f.fact);
    expect(texts).toContain('Owner world fact epsilon');
  });

  test('(4) remote recall enters withSourceScope when dispatch did not already scope it', async () => {
    const scopedEngine = new RecordingScopeEngine();
    await scopedEngine.connect({});
    await scopedEngine.initSchema();
    try {
      await scopedEngine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        ['tenant-scope'],
      );
      await scopedEngine.insertFact(
        { fact: 'Scoped recall fact', kind: 'fact', source: 'test', visibility: 'private' },
        { source_id: 'tenant-scope' },
      );

      const r = await dispatchToolCall(scopedEngine, 'recall', {}, ownerCaller('tenant-scope'));
      expect(r.isError).toBeFalsy();
      const payload = JSON.parse(r.content[0].text);
      expect((payload.facts as Array<{ fact: string }>).map(f => f.fact)).toContain('Scoped recall fact');
      expect(scopedEngine.sourceScopeCalls).toEqual(['tenant-scope']);
    } finally {
      await scopedEngine.disconnect();
    }
  });

  test('(5) recall does not double-wrap when serve-http already entered withSourceScope', async () => {
    const scopedEngine = new RecordingScopeEngine();
    await scopedEngine.connect({});
    await scopedEngine.initSchema();
    try {
      await scopedEngine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        ['tenant-active'],
      );
      await scopedEngine.insertFact(
        { fact: 'Already scoped recall fact', kind: 'fact', source: 'test', visibility: 'private' },
        { source_id: 'tenant-active' },
      );

      const r = await dispatchToolCall(scopedEngine, 'recall', {}, {
        ...ownerCaller('tenant-active'),
        sourceScopeActive: true,
      });
      expect(r.isError).toBeFalsy();
      const payload = JSON.parse(r.content[0].text);
      expect((payload.facts as Array<{ fact: string }>).map(f => f.fact)).toContain('Already scoped recall fact');
      expect(scopedEngine.sourceScopeCalls).toEqual([]);
    } finally {
      await scopedEngine.disconnect();
    }
  });
});
