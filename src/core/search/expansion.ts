/**
 * Multi-Query Expansion — v0.14+ delegates LLM call to the AI gateway.
 *
 * Sanitization layer (prompt-injection defense) stays HERE, not in the gateway:
 * the gateway is provider-agnostic; sanitization is gbrain's responsibility.
 *
 * Security (Fix 3 / M1 / M2 / M3):
 *   - sanitizeQueryForPrompt() strips injection patterns from user input
 *   - sanitizeExpansionOutput() validates LLM output before it reaches search
 *   - console.warn never logs the query text itself (privacy)
 */

import { expand as gatewayExpand, isAvailable as gatewayIsAvailable } from '../ai/gateway.ts';
import { countCJKAwareWords } from '../cjk.ts';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;
const MAX_QUERY_CHARS = 500;
const MAX_EXPANSION_ATTEMPTS = 2;

/**
 * Defense-in-depth sanitization for user queries before they reach the LLM.
 */
export function sanitizeQueryForPrompt(query: string): string {
  const original = query;
  let q = query;
  if (q.length > MAX_QUERY_CHARS) q = q.slice(0, MAX_QUERY_CHARS);
  q = q.replace(/```[\s\S]*?```/g, ' ');
  q = q.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  q = q.replace(/^(\s*(ignore|forget|disregard|override|system|assistant|human)[\s:]+)+/gi, '');
  q = q.replace(/\s+/g, ' ').trim();
  if (q !== original) {
    console.warn('[gbrain] sanitizeQueryForPrompt: stripped content from user query before LLM expansion');
  }
  return q;
}

/**
 * Validate LLM-produced alternative queries. LLM output is untrusted.
 */
export function sanitizeExpansionOutput(alternatives: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of alternatives) {
    if (typeof raw !== 'string') continue;
    let s = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (s.length === 0) continue;
    if (s.length > MAX_QUERY_CHARS) s = s.slice(0, MAX_QUERY_CHARS);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

type ExpansionGateway = (query: string) => Promise<string[]>;
type ExpansionAvailability = (touchpoint: 'expansion') => boolean;
type ExpansionWarn = (message: string) => void;

interface ExpandQueryDeps {
  expand: ExpansionGateway;
  isAvailable: ExpansionAvailability;
  warn: ExpansionWarn;
}

async function expandQueryWithDeps(query: string, deps: ExpandQueryDeps): Promise<string[]> {
  if (countCJKAwareWords(query) < MIN_WORDS) return [query];

  // Skip LLM call entirely if gateway has no expansion provider configured.
  if (!deps.isAvailable('expansion')) return [query];

  const sanitized = sanitizeQueryForPrompt(query);
  if (sanitized.length === 0) return [query];

  let warnedRetry = false;
  for (let attempt = 1; attempt <= MAX_EXPANSION_ATTEMPTS; attempt++) {
    try {
      // gateway.expand() returns [original + expansions]. We feed it the
      // sanitized copy so the LLM channel is safe; the ORIGINAL query remains
      // the first entry for downstream search.
      const gatewayResults = await deps.expand(sanitized);

      // Validate LLM-produced alternatives (everything after the first entry).
      const alternatives = gatewayResults.slice(1);
      const sanitizedAlts = sanitizeExpansionOutput(alternatives);
      if (sanitizedAlts.length === 0) {
        if (attempt < MAX_EXPANSION_ATTEMPTS) {
          deps.warn('[gbrain] expandQuery: expansion provider returned no alternatives; retrying once');
          warnedRetry = true;
          continue;
        }
        deps.warn('[gbrain] expandQuery: expansion provider returned no alternatives after retry; falling back to the original query');
        return [query];
      }

      // Original query + sanitized alternatives, deduped, capped at MAX_QUERIES.
      const all = [query, ...sanitizedAlts];
      const unique = [...new Set(all.map(q => q.toLowerCase().trim()))];
      return unique.slice(0, MAX_QUERIES).map(q =>
        all.find(orig => orig.toLowerCase().trim() === q) || q,
      );
    } catch {
      if (attempt < MAX_EXPANSION_ATTEMPTS) {
        deps.warn('[gbrain] expandQuery: expansion provider failed; retrying once');
        warnedRetry = true;
        continue;
      }
      deps.warn(
        warnedRetry
          ? '[gbrain] expandQuery: expansion provider failed after retry; falling back to the original query'
          : '[gbrain] expandQuery: expansion provider failed; falling back to the original query',
      );
      return [query];
    }
  }

  return [query];
}

export async function expandQuery(query: string): Promise<string[]> {
  return expandQueryWithDeps(query, {
    expand: gatewayExpand,
    isAvailable: gatewayIsAvailable,
    warn: (message) => console.warn(message),
  });
}

/** Test seam for fallback/retry behavior without mocking module imports. */
export async function expandQueryWithGatewayForTests(
  query: string,
  deps: ExpandQueryDeps,
): Promise<string[]> {
  return expandQueryWithDeps(query, deps);
}
