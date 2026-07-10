/**
 * Restricted-data capture scrub — drops claims carrying PCI card data, US
 * SSNs, or credentials/secrets before they are banked to the facts table.
 *
 * ## Why this exists
 *
 * Capture fires AUTONOMOUSLY: the host model decides what to hand
 * `extract_facts` (operator plane) and `save_facts` (customer plane). A
 * Social-Security number, payment-card number, or API key mentioned in
 * passing can therefore be persisted to the facts table without the user
 * ever choosing to save it. Those are exactly the categories OpenAI's
 * submission guidelines + developer terms prohibit ingesting (PCI card data,
 * PHI, credentials/secrets), and banking someone's SSN unbidden is a
 * product-integrity failure on its own — a memory tool must not silently do
 * it.
 *
 * ## Where it runs (and why not the engine)
 *
 * This detector runs at the SAME post-structuring, pre-insert seam where
 * INJECTION_PATTERNS already runs:
 *   - `facts/extract.ts` extractFactsFromTurn — the LLM plane. Covers the
 *     `extract_facts` MCP op AND conversation capture (both call it).
 *   - `facts/save.ts` runSaveFacts — the deterministic `save_facts` plane.
 *
 * NOT at engine.insertFact/insertFacts, even though that looks like the one
 * shared chokepoint: the markdown-first write path (`facts/fence-write.ts`)
 * does `renameSync(.tmp → .md)` — committing the claim to the on-disk
 * system-of-record — BEFORE it calls engine.insertFacts. An engine-layer
 * scrub would drop the DB index row but leave the SSN sitting in a markdown
 * file. The extraction seam is upstream of both the fence write and every DB
 * insert, so a drop there prevents persistence everywhere. (This is an
 * explicitly-named enforcement seam; the `guardrails.ts` hooks are
 * observe-only by contract and cannot drop, so they are not the mechanism.)
 *
 * ## Posture: CONSERVATIVE — favor false negatives over false positives
 *
 * Silently eating a legitimate fact violates the no-silent-loss principle;
 * a rare missed SSN is the lesser failure. So every detector matches only
 * high-signal shapes:
 *   - payment_card: a 13–19 digit run that passes the Luhn checksum (Luhn is
 *     the key false-positive guard — a dollar amount, a 4-digit "ends in
 *     1234", a 10-digit phone, or an order id will not match).
 *   - ssn: the distinctive XXX-XX-XXXX dashed shape always; a bare 9-digit
 *     run ONLY when an explicit SSN context token ("ssn" / "social security")
 *     is also present (a bare 9-digit number alone is invoice/account/ID-prone
 *     and is SAVED).
 *   - credential: only distinctive, prefix-anchored secret shapes (sk-…,
 *     AKIA…, ghp_…, xox[bpoa]-…, PEM private keys, …). A normal long slug,
 *     hash, UUID, or git SHA is SAVED.
 *
 * On a match the CALLER drops the offending claim, keeps the rest of the
 * batch, and logs the category via `logRestrictedDrop` — never the value.
 *
 * Pure + zero-dep. Inputs are already length-capped (≤500 chars) by the
 * sanitize pass before this sees them; every pattern is possessive-quantifier-
 * free so adversarial input stays linear-time.
 */

import { luhnOk } from '../luhn.ts';

/** The restricted-data categories gbrain refuses to bank from capture. */
export type RestrictedCategory = 'payment_card' | 'ssn' | 'credential';

/** Result of scanning one claim. `category` is the first high-signal hit. */
export interface RestrictedScan {
  restricted: boolean;
  category: RestrictedCategory | null;
}

// --- payment card -----------------------------------------------------------
// 13–19 digits, optionally split by single spaces/dashes (no commas — a
// "$4,532" amount must not look card-shaped). Every candidate is Luhn-gated.
const CARD_CANDIDATE_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

// --- SSN --------------------------------------------------------------------
// Distinctive dashed shape: 3-2-4. A 3-3-4 phone (404-555-1234) does not match.
const SSN_DASHED_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
// A bare 9-digit run, boundaried so a 10-digit phone can't trip it. Only
// treated as an SSN when an SSN context token is also present (see below).
const NINE_DIGIT_RE = /(?<!\d)\d{9}(?!\d)/;
// Explicit SSN context. \bssn\b avoids matching substrings like "assn.";
// "social security" is distinctive on its own.
const SSN_CONTEXT_RE = /\bssn\b|social\s+security/i;

// --- credentials / secrets --------------------------------------------------
// Each pattern is anchored on a distinctive, well-known prefix so a generic
// long token (slug, hash, UUID, base64 blob, git SHA) never matches.
const CREDENTIAL_RES: RegExp[] = [
  // Anthropic / OpenAI segmented keys — the "sk-ant-" / "sk-proj-" prefixes
  // are distinctive enough to allow -/_ in the body (real keys have them).
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-proj-[A-Za-z0-9_-]{10,}/,
  // Classic OpenAI key: sk- + a long PURE-alphanumeric body. Pure-alnum (no
  // -/_) keeps a hyphenated slug like "deploy-sk-config-manager" from matching.
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // AWS access key id (and the STS temp-cred sibling): AKIA/ASIA + 16 upper.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  // GitHub tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ + base62 body, plus the
  // fine-grained github_pat_ form. The underscore prefix is slug-proof.
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // Slack tokens: xoxb-/xoxp-/xoxo-/xoxa-/xoxr-/xoxs-.
  /\bxox[bpoars]-[A-Za-z0-9-]{10,}/,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Stripe live secret/restricted keys (sk_live_ / rk_live_).
  /\b[sr]k_live_[0-9A-Za-z]{16,}\b/,
  // PEM private key block (RSA / EC / OPENSSH / DSA / PGP / plain).
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
];

const NO_MATCH: RestrictedScan = { restricted: false, category: null };

/** True when `text` contains a Luhn-valid 13–19 digit card-shaped run. */
function hasPaymentCard(text: string): boolean {
  CARD_CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_CANDIDATE_RE.exec(text)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) return true;
  }
  return false;
}

/** True when `text` carries an SSN (dashed shape, or bare-9 + context token). */
function hasSsn(text: string): boolean {
  if (SSN_DASHED_RE.test(text)) return true;
  return NINE_DIGIT_RE.test(text) && SSN_CONTEXT_RE.test(text);
}

/** True when `text` contains a distinctive credential/secret shape. */
function hasCredential(text: string): boolean {
  return CREDENTIAL_RES.some(re => re.test(text));
}

/**
 * Scan one claim for restricted data. Returns the first category matched
 * (payment_card → ssn → credential); `restricted: false` when clean.
 *
 * Conservative: when nothing high-signal matches, the claim is saved.
 */
export function scanRestrictedData(text: string): RestrictedScan {
  if (!text) return NO_MATCH;
  if (hasPaymentCard(text)) return { restricted: true, category: 'payment_card' };
  if (hasSsn(text)) return { restricted: true, category: 'ssn' };
  if (hasCredential(text)) return { restricted: true, category: 'credential' };
  return NO_MATCH;
}

/**
 * Emit the value-free drop record. Category + source only — the offending
 * value is NEVER logged (re-introducing the secret in a log defeats the
 * purpose). Writes to stderr via console.warn, matching the `[facts:*]`
 * logging convention; stdout stays clean for data output.
 */
export function logRestrictedDrop(category: RestrictedCategory, source: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[facts:restricted-data] dropped 1 claim (category=${category}, source=${source}); value not logged`,
  );
}

// --- B4: structured surface-form scrub --------------------------------------

/**
 * The outcome of scrubbing a claim's structured surface forms.
 *   - people / entities — the input arrays with any element carrying restricted
 *     data REMOVED. IDENTITY-PRESERVED (same reference) when nothing was
 *     stripped, so the clean path is behaviourally unchanged.
 *   - date_context — cleared to `undefined` when it carried restricted data.
 *   - stripped — the categories removed, in encounter order (people →
 *     entities → date_context), for value-free logging. Empty when clean.
 */
export interface SurfaceScrubResult {
  people: string[] | undefined;
  entities: string[] | undefined;
  date_context: string | undefined;
  stripped: RestrictedCategory[];
}

/**
 * B4: scrub restricted data (PCI card / SSN / credential) out of a claim's
 * STRUCTURED SURFACE FORMS — people[], entities[], date_context.
 *
 * The claim TEXT is scanned separately by `scanRestrictedData`, and a hit there
 * DROPS the whole claim. The surface forms are different in kind: they are
 * who/what/when metadata that flows into the `context` column, into
 * entity_slug resolution, AND into the co-occurrence graph. A card number, SSN,
 * or API key sitting in `entities[]` would otherwise be banked verbatim (an SSN
 * could even become an entity page slug + graph node). But a co-mention is not
 * worth a whole memory, so — unlike the text path — this STRIPS the offending
 * surface form and KEEPS the claim.
 *
 * Same conservative, high-signal detector as the text scan, applied to each
 * array element and to date_context INDEPENDENTLY (so a bare 9-digit run with
 * no SSN context token is saved, exactly as in claim text). Pure; no I/O.
 */
export function scrubSurfaceForms(surface: {
  people?: string[];
  entities?: string[];
  date_context?: string;
}): SurfaceScrubResult {
  const stripped: RestrictedCategory[] = [];

  const scrubArray = (arr: string[] | undefined): string[] | undefined => {
    if (!arr) return arr;
    let removed = false;
    const kept: string[] = [];
    for (const item of arr) {
      const scan = scanRestrictedData(item);
      if (scan.restricted && scan.category) {
        stripped.push(scan.category);
        removed = true;
        continue; // strip only this element; keep the rest
      }
      kept.push(item);
    }
    // Clean path returns the SAME reference — zero behaviour change and no
    // allocation when nothing was restricted.
    return removed ? kept : arr;
  };

  const people = scrubArray(surface.people);
  const entities = scrubArray(surface.entities);

  let date_context = surface.date_context;
  if (date_context) {
    const scan = scanRestrictedData(date_context);
    if (scan.restricted && scan.category) {
      stripped.push(scan.category);
      date_context = undefined;
    }
  }

  return { people, entities, date_context, stripped };
}

/**
 * Value-free log of a surface-form strip. A DISTINCT message from
 * `logRestrictedDrop` because the claim itself is KEPT — only the offending
 * surface form was removed. Category + source only; the value is NEVER logged.
 */
export function logRestrictedSurfaceStrip(category: RestrictedCategory, source: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[facts:restricted-data] stripped 1 surface form (category=${category}, source=${source}); claim kept, value not logged`,
  );
}
