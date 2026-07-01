import { describe, expect, test } from 'bun:test';
import { expandQueryWithGatewayForTests } from '../../src/core/search/expansion.ts';

describe('expandQuery fallback observability', () => {
  test('warns and retries once when the gateway returns no alternatives', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    const out = await expandQueryWithGatewayForTests('tell me about Sightline funding', {
      isAvailable: () => true,
      expand: async (query) => {
        calls.push(query);
        return [query];
      },
      warn: (message) => warnings.push(message),
    });

    expect(out).toEqual(['tell me about Sightline funding']);
    expect(calls).toHaveLength(2);
    expect(warnings.some((message) => message.includes('returned no alternatives'))).toBe(true);
    expect(warnings.some((message) => message.includes('falling back to the original query'))).toBe(true);
  });

  test('timeout-class failures fall back immediately without a retry', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    const out = await expandQueryWithGatewayForTests('tell me about Sightline funding', {
      isAvailable: () => true,
      expand: async (query) => {
        calls.push(query);
        const err = new Error('The operation was aborted due to timeout');
        (err as Error & { name: string }).name = 'TimeoutError';
        throw err;
      },
      warn: (message) => warnings.push(message),
    });

    expect(out).toEqual(['tell me about Sightline funding']);
    expect(calls).toHaveLength(1);
    expect(warnings.some((message) => message.includes('timed out'))).toBe(true);
  });

  test('fast (non-timeout) failures still retry once', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];

    const out = await expandQueryWithGatewayForTests('tell me about Sightline funding', {
      isAvailable: () => true,
      expand: async (query) => {
        calls.push(query);
        throw new Error('connection refused');
      },
      warn: (message) => warnings.push(message),
    });

    expect(out).toEqual(['tell me about Sightline funding']);
    expect(calls).toHaveLength(2);
    expect(warnings.some((message) => message.includes('retrying once'))).toBe(true);
  });
});
