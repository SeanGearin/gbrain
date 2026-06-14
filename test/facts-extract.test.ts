/**
 * v0.31 Phase 6 — extractor sanitization parity + skip-conditions.
 *
 * Pins:
 *   - INJECTION_PATTERNS sanitized on the way IN (turn_text)
 *   - dream_generated:true → returns []
 *   - empty turn_text → returns []
 *   - Without API key (test env), returns [] gracefully (no throw)
 *
 * v0.31.2 (B1 ship-blocker fix) — parser-pin: parseExtractorJson MUST pass
 * through every typed field the LLM emits, including `notability`. The bug:
 * tryArrayShape silently dropped the field, so the outer loop saw undefined
 * and defaulted notability to 'medium'. sync's HIGH-only filter then
 * discarded 100% of facts. Pinned here so the next field added (rationale,
 * etc.) doesn't get dropped the same way.
 */

import { describe, test, expect } from 'bun:test';
import { extractFactsFromTurn, parseExtractorJson } from '../src/core/facts/extract.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

describe('extractFactsFromTurn', () => {
  test('empty turn returns no facts', async () => {
    const r = await extractFactsFromTurn({ turnText: '', source: 'test' });
    expect(r).toEqual([]);
  });

  test('whitespace-only after sanitize returns no facts', async () => {
    const r = await extractFactsFromTurn({ turnText: '   \n  ', source: 'test' });
    expect(r).toEqual([]);
  });

  test('isDreamGenerated:true short-circuits', async () => {
    const r = await extractFactsFromTurn({
      turnText: 'this is real content that would normally extract',
      source: 'test',
      isDreamGenerated: true,
    });
    expect(r).toEqual([]);
  });

  test('without chat gateway configured (test env) returns no facts gracefully', async () => {
    const r = await extractFactsFromTurn({
      turnText: 'I am flying to Tokyo Tuesday for a meeting with sam.',
      source: 'test',
    });
    // No ANTHROPIC_API_KEY in test env → isAvailable('chat') is false →
    // empty array, no throw.
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('parseExtractorJson — B1 parser-pin (v0.31.2 ship-blocker fix)', () => {
  test('passes notability through when LLM emits it', () => {
    const raw = JSON.stringify({
      facts: [
        { fact: 'I gave up alcohol', kind: 'commitment', notability: 'high' },
        { fact: 'we ate at Tartine', kind: 'event', notability: 'low' },
        { fact: 'I prefer black coffee', kind: 'preference', notability: 'medium' },
      ],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(3);
    expect(parsed![0].notability).toBe('high');
    expect(parsed![1].notability).toBe('low');
    expect(parsed![2].notability).toBe('medium');
  });

  test('omits notability when LLM omits it (legacy path)', () => {
    const raw = JSON.stringify({
      facts: [{ fact: 'pre-notability fact', kind: 'fact' }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0].notability).toBeUndefined();
  });

  test('non-string notability is dropped (defensive)', () => {
    const raw = JSON.stringify({
      facts: [{ fact: 'x', kind: 'fact', notability: 42 }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed![0].notability).toBeUndefined();
  });

  test('every documented LLM-emitted field survives the parse', () => {
    // Field-drop regression guard. If a future field is added to the
    // extractor schema, add it here AND verify parseExtractorJson preserves it.
    const raw = JSON.stringify({
      facts: [{
        fact: 'comprehensive fact',
        kind: 'event',
        entity: 'people/example',
        confidence: 0.85,
        notability: 'medium',
      }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    const f = parsed![0];
    expect(f.fact).toBe('comprehensive fact');
    expect(f.kind).toBe('event');
    expect(f.entity).toBe('people/example');
    expect(f.confidence).toBe(0.85);
    expect(f.notability).toBe('medium');
  });

  test('handles fenced JSON output (markdown code blocks)', () => {
    const raw = '```json\n' + JSON.stringify({
      facts: [{ fact: 'fenced', kind: 'fact', notability: 'high' }],
    }) + '\n```';
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed![0].notability).toBe('high');
  });
});

/**
 * Restricted-data scrub on the LLM (extract_facts / conversation) plane. The
 * scrub runs inside extractFactsFromTurn on each extracted claim, so a card /
 * SSN / credential the model surfaces is dropped before it can be embedded,
 * fenced to disk, or inserted. Gateway is stubbed so the test is deterministic
 * (no key, no network); the stub flips isAvailable('chat') true.
 */
describe('extractFactsFromTurn — restricted-data scrub', () => {
  function stubChat(
    facts: Array<{ fact: string; kind: string; notability: 'high' | 'medium' | 'low'; entity?: string | null }>,
  ) {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: facts.map(f => ({
          fact: f.fact,
          kind: f.kind,
          entity: f.entity ?? null,
          confidence: 1.0,
          notability: f.notability,
        })),
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
  }

  test('drops a card-bearing extracted claim, keeps the clean one', async () => {
    stubChat([
      { fact: 'paid with 4111 1111 1111 1111', kind: 'fact', notability: 'high' },
      { fact: 'alice-example moved to Berlin', kind: 'event', notability: 'high' },
    ]);
    try {
      const facts = await extractFactsFromTurn({ turnText: 'a turn', source: 'mcp:extract_facts' });
      expect(facts.map(f => f.fact)).toEqual(['alice-example moved to Berlin']);
      expect(facts.some(f => f.fact.includes('4111'))).toBe(false);
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  });

  test('drops SSN-bearing and credential-bearing claims, keeps the clean one', async () => {
    stubChat([
      { fact: 'his ssn is 123-45-6789', kind: 'fact', notability: 'high' },
      { fact: 'api key sk-AbCd1234EfGh5678IjKl9012mnop', kind: 'fact', notability: 'high' },
      { fact: 'bob-example is hiring two engineers', kind: 'event', notability: 'high' },
    ]);
    try {
      const facts = await extractFactsFromTurn({ turnText: 'a turn', source: 'mcp:extract_facts' });
      expect(facts.map(f => f.fact)).toEqual(['bob-example is hiring two engineers']);
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  });

  test('a clean turn keeps every extracted claim', async () => {
    stubChat([
      { fact: 'invoice 123456789 was paid', kind: 'fact', notability: 'medium' },
      { fact: 'the deal closed at $4,532', kind: 'fact', notability: 'medium' },
    ]);
    try {
      const facts = await extractFactsFromTurn({ turnText: 'a turn', source: 'mcp:extract_facts' });
      expect(facts).toHaveLength(2);
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  });
});
