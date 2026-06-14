/**
 * Luhn mod-10 checksum — the false-positive guard for payment-card detection.
 *
 * Shared primitive: both the eval-capture PII scrubber
 * (`eval-capture-scrub.ts`, redacts card numbers in captured query text) and
 * the facts restricted-data scrub (`facts/restricted-data.ts`, drops a claim
 * that carries a card number before it is banked) gate card-shaped digit runs
 * on this check. A 13–19 digit run that passes Luhn is treated as a card; one
 * that fails is left alone (order ids, account numbers, large integers).
 *
 * Pure, zero-dep, linear-time. Input is the digits-only string (callers strip
 * spaces/dashes first).
 */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (i % 2 === parity) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}
