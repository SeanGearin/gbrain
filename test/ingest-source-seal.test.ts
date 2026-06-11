/**
 * B2 write-seal — unit tests for resolveIngestSourceId.
 *
 * Pure-function coverage of the isolation invariant: a POST /ingest write
 * lands in the TOKEN's source, never a client-supplied header source; a
 * mismatched header is denied. No HTTP/Postgres harness — runs anywhere.
 *
 * The HTTP contract (401/403/200 status branches) is covered by
 * test/e2e/serve-http-ingest-webhook.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { resolveIngestSourceId } from '../src/core/ingest-source-seal.ts';

describe('B2 write-seal: resolveIngestSourceId', () => {
  test('no header → writes to the token source', () => {
    expect(resolveIngestSourceId({ sourceId: 'tenant-a' }, undefined)).toEqual({
      ok: true,
      sourceId: 'tenant-a',
    });
  });

  test('header equal to token source → allowed (no-op assertion)', () => {
    expect(resolveIngestSourceId({ sourceId: 'tenant-a' }, 'tenant-a')).toEqual({
      ok: true,
      sourceId: 'tenant-a',
    });
  });

  test('header different from token source → DENIED (cross-source write)', () => {
    const d = resolveIngestSourceId({ sourceId: 'tenant-a' }, 'tenant-b');
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.attempted).toBe('tenant-b');
      expect(d.authorized).toBe('tenant-a');
    }
  });

  test('the header value is NEVER used as the source, even when allowed', () => {
    // Allowed path returns the AUTHORIZED source, not the header echo.
    const d = resolveIngestSourceId({ sourceId: 'tenant-a' }, 'tenant-a');
    if (d.ok) expect(d.sourceId).toBe('tenant-a');
  });

  test('undefined token source falls back to default; foreign header denied', () => {
    expect(resolveIngestSourceId({ sourceId: undefined }, 'tenant-b')).toEqual({
      ok: false,
      attempted: 'tenant-b',
      authorized: 'default',
    });
  });

  test('undefined token source, no header → default', () => {
    expect(resolveIngestSourceId({ sourceId: undefined }, undefined)).toEqual({
      ok: true,
      sourceId: 'default',
    });
  });

  test('empty header string treated as absent → token source', () => {
    expect(resolveIngestSourceId({ sourceId: 'tenant-a' }, '')).toEqual({
      ok: true,
      sourceId: 'tenant-a',
    });
  });

  test('over-long header is clamped to 256 before compare (match → allowed)', () => {
    const auth256 = 'x'.repeat(256);
    const header300 = 'x'.repeat(300); // clamps to 256 'x' → equals authorized
    expect(resolveIngestSourceId({ sourceId: auth256 }, header300)).toEqual({
      ok: true,
      sourceId: auth256,
    });
  });

  test('over-long foreign header stays denied after clamp', () => {
    const d = resolveIngestSourceId({ sourceId: 'tenant-a' }, 'y'.repeat(300));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.attempted).toBe('y'.repeat(256));
  });
});
