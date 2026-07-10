/**
 * Restricted-data capture scrub — detector coverage.
 *
 * The false-positive guards ARE the point (per the packet's CONSERVATIVE
 * posture: favor false negatives over false positives — silently eating a
 * legitimate fact is the worse failure). So every category gets a positive
 * case AND the look-alikes that must be SAVED:
 *   - payment_card: Luhn-valid drops; Luhn-fail 16-digit, "$4,532",
 *     "ends in 1234", a year, and phone numbers all save.
 *   - ssn: XXX-XX-XXXX drops; bare 9-digit + context drops; a bare 9-digit
 *     invoice number with no SSN context saves; "assn." doesn't trip \bssn\b.
 *   - credential: sk-/AKIA/ghp_/xox/PEM drop; a normal long slug, git SHA,
 *     and UUID save.
 *
 * Plus: category attribution is correct, and the scan stays linear-time on
 * adversarial input.
 */

import { describe, expect, test } from 'bun:test';
import {
  scanRestrictedData,
  logRestrictedDrop,
  scrubSurfaceForms,
  logRestrictedSurfaceStrip,
} from '../src/core/facts/restricted-data.ts';

describe('scanRestrictedData — clean input saves', () => {
  test('empty string is not restricted', () => {
    expect(scanRestrictedData('').restricted).toBe(false);
  });

  test('an ordinary personal-knowledge claim saves', () => {
    expect(scanRestrictedData('alice-example is leaving YC to start a company').restricted).toBe(false);
  });
});

describe('scanRestrictedData — payment_card (Luhn-gated)', () => {
  test('Luhn-valid Visa with spaces drops', () => {
    const r = scanRestrictedData('paid with card 4111 1111 1111 1111');
    expect(r.restricted).toBe(true);
    expect(r.category).toBe('payment_card');
  });

  test('Luhn-valid card with no separators drops', () => {
    expect(scanRestrictedData('card 4111111111111111').category).toBe('payment_card');
  });

  test('Luhn-valid card with dashes drops', () => {
    expect(scanRestrictedData('4111-1111-1111-1111').category).toBe('payment_card');
  });

  test('Luhn-valid 15-digit Amex drops', () => {
    // 378282246310005 is the canonical Amex test number (valid Luhn, 15 digits).
    expect(scanRestrictedData('amex 3782 822463 10005').category).toBe('payment_card');
  });

  test('16-digit integer that FAILS Luhn saves (order id)', () => {
    // 1234567890123456 fails Luhn.
    expect(scanRestrictedData('order id 1234567890123456').restricted).toBe(false);
  });

  test('a dollar amount saves ("$4,532 on the deal")', () => {
    expect(scanRestrictedData('$4,532 on the deal').restricted).toBe(false);
  });

  test('"ends in 1234" saves', () => {
    expect(scanRestrictedData('the card ends in 1234').restricted).toBe(false);
  });

  test('a 4-digit year saves', () => {
    expect(scanRestrictedData('founded in 2026').restricted).toBe(false);
  });
});

describe('scanRestrictedData — ssn', () => {
  test('formatted XXX-XX-XXXX drops', () => {
    const r = scanRestrictedData('ssn is 123-45-6789 on file');
    expect(r.restricted).toBe(true);
    expect(r.category).toBe('ssn');
  });

  test('formatted SSN drops even with no context word (distinctive shape)', () => {
    expect(scanRestrictedData('123-45-6789').category).toBe('ssn');
  });

  test('bare 9-digit run WITH "ssn" context drops', () => {
    expect(scanRestrictedData('my ssn 123456789').category).toBe('ssn');
  });

  test('bare 9-digit run WITH "social security" context drops', () => {
    expect(scanRestrictedData('social security number 123456789').category).toBe('ssn');
  });

  test('bare 9-digit invoice number with NO SSN context saves', () => {
    expect(scanRestrictedData('invoice 123456789 paid').restricted).toBe(false);
  });

  test('"assn." substring does NOT count as ssn context', () => {
    // \bssn\b must not match the "ssn" inside "assn."
    expect(scanRestrictedData('homeowners assn. 123456789 dues').restricted).toBe(false);
  });

  test('a phone number 404-555-1234 saves (3-3-4, not 3-2-4)', () => {
    expect(scanRestrictedData('call 404-555-1234 tomorrow').restricted).toBe(false);
  });

  test('a 10-digit phone with no separators saves', () => {
    expect(scanRestrictedData('reach me at 4045551234').restricted).toBe(false);
  });
});

describe('scanRestrictedData — credential', () => {
  test('classic sk- key (long alphanumeric body) drops', () => {
    expect(scanRestrictedData('key is sk-AbCd1234EfGh5678IjKl9012mnop').category).toBe('credential');
  });

  test('sk-ant- key drops', () => {
    expect(scanRestrictedData('ANTHROPIC_API_KEY=sk-ant-api03-aBc123_def-456').category).toBe('credential');
  });

  test('AWS AKIA access key id drops', () => {
    expect(scanRestrictedData('AKIAIOSFODNN7EXAMPLE is the key').category).toBe('credential');
  });

  test('GitHub ghp_ token drops', () => {
    expect(scanRestrictedData('ghp_1234567890abcdefABCDEF1234567890abcd').category).toBe('credential');
  });

  test('Slack xoxb- token drops', () => {
    expect(scanRestrictedData('xoxb-123456789012-abcdefghijkl').category).toBe('credential');
  });

  test('PEM private key block drops', () => {
    expect(scanRestrictedData('-----BEGIN PRIVATE KEY-----').category).toBe('credential');
  });

  test('PEM RSA private key block drops', () => {
    expect(scanRestrictedData('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').category).toBe('credential');
  });

  test('a normal long hyphenated slug saves (sk- in the middle, hyphenated body)', () => {
    expect(scanRestrictedData('deploy-sk-config-management-system-v2').restricted).toBe(false);
  });

  test('a 40-char git SHA saves', () => {
    expect(scanRestrictedData('commit da39a3ee5e6b4b0d3255bfef95601890afd80709').restricted).toBe(false);
  });

  test('a UUID saves', () => {
    expect(scanRestrictedData('run 550e8400-e29b-41d4-a716-446655440000').restricted).toBe(false);
  });

  test('a long base64-ish content hash saves', () => {
    expect(scanRestrictedData('hash YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw').restricted).toBe(false);
  });
});

describe('scanRestrictedData — category precedence + safety', () => {
  test('payment_card wins when both a card and a credential are present', () => {
    // Order is payment_card → ssn → credential.
    expect(scanRestrictedData('sk-AbCd1234EfGh5678IjKl9012 and 4111111111111111').category).toBe('payment_card');
  });

  test('stays linear-time on adversarial input', () => {
    const adversarial = '1'.repeat(10000) + ' ' + 'a'.repeat(10000);
    const start = Date.now();
    const r = scanRestrictedData(adversarial);
    expect(Date.now() - start).toBeLessThan(1000); // realistic target <50ms
    expect(typeof r.restricted).toBe('boolean');
  });
});

describe('scrubSurfaceForms — B4: strip the surface form, keep the claim', () => {
  test('clean surface forms pass through untouched (same references, no strips)', () => {
    const people = ['Priya', 'Marcus'];
    const entities = ['Boltline', 'Acme Corp'];
    const r = scrubSurfaceForms({ people, entities, date_context: 'last March' });
    expect(r.stripped).toEqual([]);
    // Identity-preserved on the clean path — zero behaviour change.
    expect(r.people).toBe(people);
    expect(r.entities).toBe(entities);
    expect(r.date_context).toBe('last March');
  });

  test('undefined surface forms stay undefined', () => {
    const r = scrubSurfaceForms({});
    expect(r.people).toBeUndefined();
    expect(r.entities).toBeUndefined();
    expect(r.date_context).toBeUndefined();
    expect(r.stripped).toEqual([]);
  });

  test('a dashed SSN in entities[] is stripped; the rest of the array is kept', () => {
    const r = scrubSurfaceForms({ entities: ['Acme Corp', '123-45-6789', 'Beacon Properties'] });
    expect(r.entities).toEqual(['Acme Corp', 'Beacon Properties']);
    expect(r.stripped).toEqual(['ssn']);
  });

  test('a Luhn-valid card in people[] is stripped', () => {
    const r = scrubSurfaceForms({ people: ['Dana', '4111 1111 1111 1111'] });
    expect(r.people).toEqual(['Dana']);
    expect(r.stripped).toEqual(['payment_card']);
  });

  test('a credential in entities[] is stripped', () => {
    const r = scrubSurfaceForms({ entities: ['sk-AbCd1234EfGh5678IjKl9012mnop'] });
    expect(r.entities).toEqual([]); // array survives (empty), the secret does not
    expect(r.stripped).toEqual(['credential']);
  });

  test('date_context carrying an SSN is cleared to undefined', () => {
    const r = scrubSurfaceForms({ date_context: 'the day his ssn 123456789 was issued' });
    expect(r.date_context).toBeUndefined();
    expect(r.stripped).toEqual(['ssn']);
  });

  test('conservative parity with the text scan: a bare 9-digit entity with NO SSN context is KEPT', () => {
    const r = scrubSurfaceForms({ entities: ['account 123456789'] });
    expect(r.entities).toEqual(['account 123456789']);
    expect(r.stripped).toEqual([]);
  });

  test('strips across multiple surface forms and reports each category in encounter order', () => {
    const r = scrubSurfaceForms({
      people: ['Dana', '4111111111111111'],
      entities: ['Acme', '123-45-6789'],
      date_context: 'signed with sk-AbCd1234EfGh5678IjKl9012mnop',
    });
    expect(r.people).toEqual(['Dana']);
    expect(r.entities).toEqual(['Acme']);
    expect(r.date_context).toBeUndefined();
    // people → entities → date_context.
    expect(r.stripped).toEqual(['payment_card', 'ssn', 'credential']);
  });

  test('scrubbing never surfaces the stripped value anywhere in the result', () => {
    const r = scrubSurfaceForms({ entities: ['078-05-1120'], people: ['4111111111111111'] });
    expect(JSON.stringify(r)).not.toContain('078-05-1120');
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
  });
});

describe('logRestrictedSurfaceStrip — never logs the value, says "claim kept"', () => {
  test('logs the category + source (claim kept), not the value', () => {
    const original = console.warn;
    const lines: string[] = [];
    // eslint-disable-next-line no-console
    console.warn = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logRestrictedSurfaceStrip('ssn', 'mcp:save_facts');
    } finally {
      // eslint-disable-next-line no-console
      console.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('category=ssn');
    expect(lines[0]).toContain('source=mcp:save_facts');
    expect(lines[0]).toContain('claim kept');
    expect(lines[0]).toContain('value not logged');
    expect(lines[0]).not.toMatch(/\d{6,}/);
  });
});

describe('logRestrictedDrop — never logs the value', () => {
  test('logs the category + source, not the value', () => {
    const original = console.warn;
    const lines: string[] = [];
    // eslint-disable-next-line no-console
    console.warn = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logRestrictedDrop('payment_card', 'mcp:save_facts');
    } finally {
      // eslint-disable-next-line no-console
      console.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('category=payment_card');
    expect(lines[0]).toContain('source=mcp:save_facts');
    expect(lines[0]).toContain('value not logged');
    // The line carries no digit run that could be a leaked value.
    expect(lines[0]).not.toMatch(/\d{6,}/);
  });
});
