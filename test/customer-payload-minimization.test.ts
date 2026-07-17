/**
 * Customer tenant payload minimization.
 *
 * The worker's tenant-brain surface calls gbrain with a source-bound,
 * non-default OAuth client. Those responses must keep consumer handles
 * (slugs, fact ids) without exposing tenant-internal scope or row ids.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

const SOURCE_ID = 'tenant-min';
const SLUG = 'notes/minimized-payload';

let engine: PGLiteEngine;
let factId: number;

const customerAuth: AuthInfo = {
  token: 'test-token',
  clientId: 'tenant-client',
  clientName: 'Tenant Client',
  scopes: ['read', 'write'],
  sourceId: SOURCE_ID,
  allowedSources: [SOURCE_ID],
};

const operatorAuth: AuthInfo = {
  token: 'operator-token',
  clientId: 'operator-client',
  clientName: 'Operator Client',
  scopes: ['read', 'write'],
  sourceId: 'default',
  allowedSources: [SOURCE_ID],
};

function parsePayload<T = Record<string, unknown>>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ($1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE_ID, SOURCE_ID],
  );

  await engine.putPage(
    SLUG,
    {
      type: 'note',
      title: 'Minimized Payload',
      compiled_truth: 'Tenant minimization needle lives here.',
      timeline: '',
      source_kind: 'webhook',
      source_uri: 'tenant-internal://source/secret',
      ingested_via: 'tenant-webhook',
    },
    { sourceId: SOURCE_ID },
  );
  await engine.upsertChunks(
    SLUG,
    [{
      chunk_index: 0,
      chunk_text: 'Tenant minimization needle lives here.',
      chunk_source: 'compiled_truth',
      token_count: 6,
    }],
    { sourceId: SOURCE_ID },
  );
  await engine.addTimelineEntry(
    SLUG,
    { date: '2026-06-16', source: 'test', summary: 'Customer timeline event', detail: 'detail' },
    { sourceId: SOURCE_ID },
  );
  await engine.executeRaw(
    `UPDATE pages
        SET emotional_weight = 1, salience_touched_at = now()
      WHERE slug = $1 AND source_id = $2`,
    [SLUG, SOURCE_ID],
  );

  const inserted = await engine.insertFact(
    {
      fact: 'customer fact id remains usable',
      kind: 'fact',
      entity_slug: SLUG,
      source: 'mcp:save_facts',
      source_session: 'tenant-session-secret',
      visibility: 'world',
      embedding: null,
    },
    { source_id: SOURCE_ID },
  );
  factId = inserted.id;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('customer-scoped remote reads', () => {
  test('minimize internal identifiers while preserving consumer handles', async () => {
    const customerOpts = { remote: true, sourceId: SOURCE_ID, auth: customerAuth };

    const page = parsePayload(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, customerOpts));
    expect(page.slug).toBe(SLUG);
    expect(page).not.toHaveProperty('id');
    expect(page).not.toHaveProperty('source_id');
    expect(page).not.toHaveProperty('source_kind');
    expect(page).not.toHaveProperty('source_uri');
    expect(page).not.toHaveProperty('ingested_via');

    const recall = parsePayload<{ facts: Array<Record<string, unknown>> }>(
      await dispatchToolCall(engine, 'recall', { entity: 'minimized-payload' }, customerOpts),
    );
    expect(recall.facts[0].id).toBe(factId);
    expect(recall.facts[0]).not.toHaveProperty('source_session');

    // SR-6 (engine audit 2026-07-17): query now returns the
    // {results, search_health} envelope — the minimization contract applies
    // to the rows INSIDE it (operations.ts wraps minimizeSearchResults at
    // every envelope build site).
    const query = parsePayload<{
      results: Array<Record<string, unknown>>;
      search_health: Record<string, unknown>;
    }>(
      await dispatchToolCall(engine, 'query', { query: 'minimization needle', limit: 1, expand: false }, customerOpts),
    );
    expect(query.results[0].slug).toBe(SLUG);
    expect(query.results[0]).not.toHaveProperty('page_id');
    expect(query.results[0]).not.toHaveProperty('chunk_id');
    expect(query.results[0]).not.toHaveProperty('source_id');

    const timeline = parsePayload<Array<Record<string, unknown>>>(
      await dispatchToolCall(engine, 'get_timeline', { slug: SLUG }, customerOpts),
    );
    expect(timeline[0].summary).toBe('Customer timeline event');
    expect(timeline[0]).not.toHaveProperty('id');
    expect(timeline[0]).not.toHaveProperty('page_id');

    const salience = parsePayload<Array<Record<string, unknown>>>(
      await dispatchToolCall(engine, 'get_recent_salience', { days: 1, limit: 5 }, customerOpts),
    );
    expect(salience[0].slug).toBe(SLUG);
    expect(salience[0]).not.toHaveProperty('source_id');
  });

  test('local operator reads keep full fields', async () => {
    const localOpts = { remote: false, sourceId: SOURCE_ID };

    const page = parsePayload(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, localOpts));
    expect(page).toHaveProperty('id');
    expect(page).toHaveProperty('source_id', SOURCE_ID);
    expect(page).toHaveProperty('source_kind', 'webhook');
    expect(page).toHaveProperty('source_uri', 'tenant-internal://source/secret');

    const recall = parsePayload<{ facts: Array<Record<string, unknown>> }>(
      await dispatchToolCall(engine, 'recall', { entity: 'minimized-payload' }, localOpts),
    );
    expect(recall.facts[0]).toHaveProperty('source_session', 'tenant-session-secret');
  });

  test('remote operator reads keep full fields', async () => {
    const operatorOpts = { remote: true, sourceId: SOURCE_ID, auth: operatorAuth };

    const page = parsePayload(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, operatorOpts));
    expect(page).toHaveProperty('id');
    expect(page).toHaveProperty('source_id', SOURCE_ID);
    expect(page).toHaveProperty('source_kind', 'webhook');
    expect(page).toHaveProperty('source_uri', 'tenant-internal://source/secret');

    const recall = parsePayload<{ facts: Array<Record<string, unknown>> }>(
      await dispatchToolCall(engine, 'recall', { entity: 'minimized-payload' }, operatorOpts),
    );
    expect(recall.facts[0]).toHaveProperty('source_session', 'tenant-session-secret');
  });
});
