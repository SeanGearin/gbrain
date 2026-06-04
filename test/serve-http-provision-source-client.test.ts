/**
 * Unit tests for provisionSourceClient — the B4 tenant-provisioning primitive
 * behind POST /admin/provision-source-client (serve-http.ts).
 *
 * The route handler lives inside runServeHttp's Express closure (hard to invoke
 * without bringing up the full app), so — following the codebase idiom
 * (probeHealth / probeLiveness / queryAgentClientSpend, and the note in
 * test/sources-webhook.test.ts) — these tests pin the extracted load-bearing
 * function against an in-process PGLite engine. The full HTTP path (bearer
 * middleware + sources_admin scope gate) is the DATABASE_URL-gated e2e concern.
 *
 * Contract pinned (design phase2-b4-provisioning §4):
 *   - charset ^[a-z0-9-]{1,32}^ via the canonical isValidSourceId
 *   - atomic source + source-bound oauth_client creation
 *   - secret returned exactly once
 *   - idempotent per source_id (409 + existing client_id, no secret)
 *   - source-without-client partial state self-heals on retry
 *   - secret hashing reused (client_secret verifies against stored SHA-256 hash)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { provisionSourceClient, recordProvisionAudit } from '../src/commands/serve-http.ts';
import { hashToken } from '../src/core/utils.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), tokenTtl: 60, refreshTtl: 300 });
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 15_000);

// PGLite returns TEXT[] either as a JS array or a '{a,b}' literal depending on
// codec; normalize so assertions don't depend on which.
function coerceArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    return inner.length === 0 ? [] : inner.split(',').map(s => s.replace(/^"|"$/g, ''));
  }
  return [];
}

async function clientRow(clientId: string) {
  const rows = await engine.executeRaw<{
    client_id: string;
    client_name: string;
    client_secret_hash: string;
    scope: string;
    grant_types: unknown;
    source_id: string;
    federated_read: unknown;
  }>(
    `SELECT client_id, client_name, client_secret_hash, scope, grant_types, source_id, federated_read
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return rows[0];
}

async function clientsForSource(sourceId: string) {
  return engine.executeRaw<{ client_id: string }>(
    `SELECT client_id FROM oauth_clients WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
}

async function sourceRows(sourceId: string) {
  return engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [sourceId]);
}

describe('provisionSourceClient — happy path', () => {
  test('creates source + bound client and returns the secret once', async () => {
    const result = await provisionSourceClient(engine, provider, { source_id: 't-happy1' });
    expect(result.status).toBe(200);
    const body = result.body as { source_id: string; client_id: string; client_secret: string };
    expect(body.source_id).toBe('t-happy1');
    expect(body.client_id).toStartWith('gbrain_cl_');
    expect(body.client_secret).toStartWith('gbrain_cs_');

    // Source row exists.
    expect((await sourceRows('t-happy1')).length).toBe(1);

    // Exactly one client bound to the source.
    expect((await clientsForSource('t-happy1')).length).toBe(1);

    const row = await clientRow(body.client_id);
    expect(row.source_id).toBe('t-happy1');
    expect(row.scope).toBe('read write');
    expect(coerceArray(row.grant_types)).toContain('client_credentials');
    // federated_read defaults to [source_id] (isolated read).
    expect(coerceArray(row.federated_read)).toEqual(['t-happy1']);
  });

  test('returned secret verifies against the stored SHA-256 hash (hashing reused)', async () => {
    const result = await provisionSourceClient(engine, provider, { source_id: 't-hash1' });
    expect(result.status).toBe(200);
    const body = result.body as { client_id: string; client_secret: string };
    const row = await clientRow(body.client_id);
    expect(row.client_secret_hash).toBe(hashToken(body.client_secret));
  });

  test('display_name defaults to source_id, honored when provided', async () => {
    const dflt = await provisionSourceClient(engine, provider, { source_id: 't-disp1' });
    expect((await clientRow((dflt.body as any).client_id)).client_name).toBe('t-disp1');

    const named = await provisionSourceClient(engine, provider, { source_id: 't-disp2', display_name: 'Acme Example' });
    expect((await clientRow((named.body as any).client_id)).client_name).toBe('Acme Example');
  });
});

describe('provisionSourceClient — idempotency (mint-once)', () => {
  test('second call for the same source returns 409 with existing client_id and NO secret', async () => {
    const first = await provisionSourceClient(engine, provider, { source_id: 't-idem1' });
    expect(first.status).toBe(200);
    const firstClientId = (first.body as any).client_id;

    const second = await provisionSourceClient(engine, provider, { source_id: 't-idem1' });
    expect(second.status).toBe(409);
    const body = second.body as Record<string, unknown>;
    expect(body.error).toBe('already_provisioned');
    expect(body.client_id).toBe(firstClientId);
    expect('client_secret' in body).toBe(false);

    // No duplicate client, no duplicate source.
    expect((await clientsForSource('t-idem1')).length).toBe(1);
    expect((await sourceRows('t-idem1')).length).toBe(1);
  });
});

describe('provisionSourceClient — partial-state recovery', () => {
  test('a source that exists without a client gets its client minted on retry', async () => {
    // Simulate the saga crashing after source-create, before client-mint.
    const { addSource } = await import('../src/core/sources-ops.ts');
    await addSource(engine, { id: 't-orphan1', name: 't-orphan1', localPath: null, federated: false });
    expect((await sourceRows('t-orphan1')).length).toBe(1);
    expect((await clientsForSource('t-orphan1')).length).toBe(0);

    const result = await provisionSourceClient(engine, provider, { source_id: 't-orphan1' });
    expect(result.status).toBe(200);
    expect((await clientsForSource('t-orphan1')).length).toBe(1);
    // Source not duplicated.
    expect((await sourceRows('t-orphan1')).length).toBe(1);
  });
});

describe('provisionSourceClient — charset enforcement', () => {
  const bad: Array<[string, unknown]> = [
    ['underscore', 't_bad'],
    ['leading hyphen', '-bad'],
    ['trailing hyphen', 'bad-'],
    ['uppercase', 'tBad'],
    ['too long (33)', 'a'.repeat(33)],
    ['empty string', ''],
    ['slash', 'a/b'],
    ['missing', undefined],
    ['non-string number', 42],
    ['non-string object', { id: 'x' }],
  ];

  for (const [label, value] of bad) {
    test(`rejects ${label} with 400 and creates nothing`, async () => {
      const result = await provisionSourceClient(engine, provider, { source_id: value });
      expect(result.status).toBe(400);
      expect((result.body as any).error).toBe('invalid_source_id');
      if (typeof value === 'string') {
        expect((await sourceRows(value)).length).toBe(0);
        expect((await clientsForSource(value)).length).toBe(0);
      }
    });
  }

  test('accepts a minted-style t- id (interior hyphen, alnum edges)', async () => {
    const result = await provisionSourceClient(engine, provider, { source_id: 't-k7m2q9rax4' });
    expect(result.status).toBe(200);
  });
});

describe('provisionSourceClient — federated_read', () => {
  test('honors a valid federated_read list', async () => {
    const result = await provisionSourceClient(engine, provider, {
      source_id: 't-fed1',
      federated_read: ['t-fed1', 't-shared'],
    });
    expect(result.status).toBe(200);
    const row = await clientRow((result.body as any).client_id);
    expect(coerceArray(row.federated_read).sort()).toEqual(['t-fed1', 't-shared']);
  });

  test('rejects a federated_read with an invalid entry (400, nothing created)', async () => {
    const result = await provisionSourceClient(engine, provider, {
      source_id: 't-fed2',
      federated_read: ['t-fed2', 'BAD_ENTRY'],
    });
    expect(result.status).toBe(400);
    expect((result.body as any).error).toBe('invalid_federated_read');
    expect((await sourceRows('t-fed2')).length).toBe(0);
    expect((await clientsForSource('t-fed2')).length).toBe(0);
  });

  test('rejects a non-array federated_read', async () => {
    const result = await provisionSourceClient(engine, provider, {
      source_id: 't-fed3',
      federated_read: 't-fed3',
    });
    expect(result.status).toBe(400);
    expect((result.body as any).error).toBe('invalid_federated_read');
  });
});

describe('provisionSourceClient — isolation', () => {
  test('two tenants each get a distinct client bound to their own source', async () => {
    const a = await provisionSourceClient(engine, provider, { source_id: 't-isoa' });
    const b = await provisionSourceClient(engine, provider, { source_id: 't-isob' });
    const aId = (a.body as any).client_id;
    const bId = (b.body as any).client_id;
    expect(aId).not.toBe(bId);
    expect((await clientRow(aId)).source_id).toBe('t-isoa');
    expect((await clientRow(bId)).source_id).toBe('t-isob');
  });
});

// ---------------------------------------------------------------------------
// recordProvisionAudit — mcp_request_log row + SSE broadcast, secret-free
// ---------------------------------------------------------------------------

async function auditRow(tokenName: string) {
  const rows = await engine.executeRaw<{
    token_name: string;
    agent_name: string;
    operation: string;
    status: string;
    error_message: string | null;
    params_text: string;
  }>(
    `SELECT token_name, agent_name, operation, status, error_message, params::text AS params_text
       FROM mcp_request_log
      WHERE operation = 'provision-source-client' AND token_name = $1
      ORDER BY id DESC LIMIT 1`,
    [tokenName],
  );
  return rows[0];
}

describe('recordProvisionAudit — persists row + broadcasts, never leaks the secret', () => {
  test('success: row + broadcast carry source_id/client_id, NEVER the secret', async () => {
    const SECRET = 'gbrain_cs_SUPERSECRET_must_not_persist_0001';
    const authInfo = { clientId: 'gbrain_cl_caller_ok', clientName: 'audit-caller', scopes: ['sources_admin'] };
    const result = {
      status: 200,
      body: { source_id: 't-audit-ok', client_id: 'gbrain_cl_minted_ok', client_secret: SECRET },
    };
    const events: Record<string, unknown>[] = [];
    await recordProvisionAudit(engine, {
      authInfo, sourceId: 't-audit-ok', result, latencyMs: 7, broadcast: e => events.push(e),
    });

    // Persisted row.
    const row = await auditRow('gbrain_cl_caller_ok');
    expect(row).toBeDefined();
    expect(row.operation).toBe('provision-source-client');
    expect(row.status).toBe('success');
    expect(row.agent_name).toBe('audit-caller');
    expect(row.error_message).toBeNull();
    expect(row.params_text).toContain('t-audit-ok'); // source_id present
    expect(row.params_text).toContain('gbrain_cl_minted_ok'); // client_id present
    // SECRET ABSENT from the entire persisted row.
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row.params_text).not.toContain('SUPERSECRET');

    // Broadcast event.
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('success');
    expect(events[0].source_id).toBe('t-audit-ok');
    expect(events[0].client_id).toBe('gbrain_cl_minted_ok');
    expect(events[0].operation).toBe('provision-source-client');
    // SECRET ABSENT from the broadcast payload.
    expect(JSON.stringify(events[0])).not.toContain(SECRET);
  });

  test('authorization deny (403): row + broadcast with status error', async () => {
    const authInfo = { clientId: 'gbrain_cl_caller_deny', clientName: 'denied-caller', scopes: ['read'] };
    const result = { status: 403, body: { error: 'insufficient_scope', message: "requires 'sources_admin'" } };
    const events: Record<string, unknown>[] = [];
    await recordProvisionAudit(engine, {
      authInfo, sourceId: 't-audit-deny', result, latencyMs: 1, broadcast: e => events.push(e),
    });

    const row = await auditRow('gbrain_cl_caller_deny');
    expect(row.status).toBe('error');
    expect(row.error_message).toContain('insufficient_scope');
    expect(row.params_text).toContain('t-audit-deny');

    expect(events.length).toBe(1);
    expect(events[0].status).toBe('error');
    expect((events[0].error as { code?: string }).code).toBe('insufficient_scope');
  });

  test('invalid input (non-string source_id): row marks invalid_input, no client_id', async () => {
    const authInfo = { clientId: 'gbrain_cl_caller_bad', clientName: 'bad-caller', scopes: ['sources_admin'] };
    const result = { status: 400, body: { error: 'invalid_source_id', message: 'bad charset' } };
    await recordProvisionAudit(engine, {
      authInfo, sourceId: 42, result, latencyMs: 1,
    });

    const row = await auditRow('gbrain_cl_caller_bad');
    expect(row.status).toBe('error');
    expect(row.params_text).toContain('invalid_input');
    expect(row.error_message).toContain('invalid_source_id');
  });

  test('never throws and writes the row even without a broadcast callback', async () => {
    const authInfo = { clientId: 'gbrain_cl_caller_nobroadcast', clientName: 'nb', scopes: ['sources_admin'] };
    const result = { status: 200, body: { source_id: 't-audit-nb', client_id: 'gbrain_cl_nb', client_secret: 'gbrain_cs_x' } };
    await expect(
      recordProvisionAudit(engine, { authInfo, sourceId: 't-audit-nb', result, latencyMs: 1 }),
    ).resolves.toBeUndefined();
    expect((await auditRow('gbrain_cl_caller_nobroadcast')).status).toBe('success');
  });
});
