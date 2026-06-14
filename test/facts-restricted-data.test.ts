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
import { scanRestrictedData, logRestrictedDrop } from '../src/core/facts/restricted-data.ts';

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
