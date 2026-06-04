/**
 * E2E tests for POST /admin/provision-source-client (B4 tenant provisioning).
 *
 * Spins up a real `gbrain serve --http` against real Postgres and exercises the
 * full HTTP path that the in-process unit tests cannot: the real bearer
 * middleware (requireBearerAuth) and the real sources_admin scope gate over the
 * wire. Joins the B2 serve-http e2e family (serve-http-oauth.test.ts,
 * serve-http-ingest-webhook.test.ts) that runs at deploy time.
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-provision-source-client.test.ts
 * (DATABASE_URL-gated — skips gracefully when unset, like the rest of the family.
 *  The DB must be schema-bootstrapped first; see CLAUDE.md E2E lifecycle.)
 *
 * Covered (the wire-level contract; audit-row correctness is unit-covered in
 * test/serve-http-provision-source-client.test.ts):
 *   - sources_admin bearer → 200, source + source-bound client minted, secret once
 *   - idempotent per source_id → 409, existing client_id, NO secret
 *   - read-only bearer → 403 insufficient_scope (the real scope gate)
 *   - no bearer → 401 (requireBearerAuth middleware)
 *   - invalid charset over the wire → 400
 *   - the returned tenant creds complete a real client_credentials grant (B6 path)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { hasDatabase } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-provision-source-client tests (DATABASE_URL not set)');
}

const PORT = 19132; // Avoid collision with production 3131 and the oauth e2e (19131).
const BASE = `http://localhost:${PORT}`;

// Unique-per-run tenant ids so re-runs against a persistent DB don't collide
// (the 200-then-409 pair depends on a fresh source). Charset-legal: t- + hex.
const RUN = randomBytes(3).toString('hex');
const SRC_OK = `t-e2e${RUN}a`;
const SRC_DENY = `t-e2e${RUN}b`;

describeE2E('serve-http /admin/provision-source-client E2E', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let provClientId: string | undefined;
  let provClientSecret: string | undefined;
  const mintedTenantClientIds: string[] = [];

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');

    // Register the provisioning client. env: { ...process.env } is required —
    // bun's execSync does not inherit process.env mutations from helpers.ts's
    // .env.testing load (see serve-http-oauth.test.ts for the full note).
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-provisioner --grant-types client_credentials --scopes "sources_admin read write"',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) throw new Error('Failed to register provisioning client:\n' + regOutput);
    provClientId = idMatch[1];
    provClientSecret = secretMatch[1];

    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    const { execSync } = await import('child_process');
    const toRevoke = [...(provClientId ? [provClientId] : []), ...mintedTenantClientIds];
    for (const id of toRevoke) {
      try {
        execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      } catch (e: any) {
        console.error(`[afterAll] revoke-client cleanup failed for ${id}: ${e.message}`);
      }
    }
  }, 30_000);

  async function mintToken(scope: string): Promise<string> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${provClientId}&client_secret=${provClientSecret}&scope=${encodeURIComponent(scope)}`,
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  async function provision(token: string | null, body: unknown): Promise<Response> {
    return fetch(`${BASE}/admin/provision-source-client`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  test('no bearer → 401 (requireBearerAuth middleware)', async () => {
    const res = await provision(null, { source_id: SRC_OK });
    expect(res.status).toBe(401);
  });

  test('read-only bearer → 403 insufficient_scope (real scope gate)', async () => {
    const token = await mintToken('read');
    const res = await provision(token, { source_id: SRC_DENY });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('insufficient_scope');
  });

  test('invalid charset → 400', async () => {
    const token = await mintToken('sources_admin');
    const res = await provision(token, { source_id: 'bad_underscore' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_source_id');
  });

  test('sources_admin bearer → 200, mints source-bound client, secret once', async () => {
    const token = await mintToken('sources_admin');
    const res = await provision(token, { source_id: SRC_OK, display_name: 'E2E Tenant' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source_id: string; client_id: string; client_secret: string };
    expect(body.source_id).toBe(SRC_OK);
    expect(body.client_id).toMatch(/^gbrain_cl_/);
    expect(body.client_secret).toMatch(/^gbrain_cs_/);
    mintedTenantClientIds.push(body.client_id);

    // The returned tenant creds complete a real client_credentials grant — the
    // B6 path that turns these creds into a per-tenant bearer. Proves the minted
    // client is real and usable, not just a row.
    const grant = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${body.client_id}&client_secret=${encodeURIComponent(body.client_secret)}&scope=read`,
    });
    expect(grant.ok).toBe(true);
    const grantData = (await grant.json()) as { access_token: string };
    expect(grantData.access_token).toMatch(/^gbrain_at_/);
  }, 15_000);

  test('idempotent per source_id → 409, existing client_id, NO secret', async () => {
    const token = await mintToken('sources_admin');
    const res = await provision(token, { source_id: SRC_OK });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('already_provisioned');
    expect(body.source_id).toBe(SRC_OK);
    expect(typeof body.client_id).toBe('string');
    expect('client_secret' in body).toBe(false);
  });
});
