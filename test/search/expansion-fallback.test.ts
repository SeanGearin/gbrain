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
});
