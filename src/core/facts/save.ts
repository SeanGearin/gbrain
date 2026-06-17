/**
 * B7 save_facts (pass 1) — deterministic structured-facts intake.
 *
 * The product inversion: on the customer (tenant) plane the customer's OWN
 * Claude does the cognition (reads the conversation, decides what's worth
 * remembering, structures it into claims) and hands the server pre-extracted
 * claims. The server does ONLY deterministic work — validate, sanitize, dedup,
 * insert. There is NO chat-model call anywhere on this path, by construction:
 * this module imports `chat`/`classifyAgainstCandidates` from nowhere, and the
 * only gateway calls it makes are the embedding lane (Layer-2 dedup), guarded
 * by isAvailable('embedding') and a try/catch that degrades to NULL.
 *
 * This replaces the failed extract_facts round-trip on the tenant plane:
 * extract_facts needs the chat gateway (broken-closed on tenant bearers as a
 * cost firewall), so a tenant extract_facts always fell back to a freeform
 * put_page. save_facts is the purpose-built path — structured fact rows that
 * feed the graph layer (dedup, supersession, consolidation, takes).
 *
 * Trust boundary: claim text is attacker-controlled input arriving with write
 * privileges. Mitigation — strict schema (rejects the whole batch on a
 * malformed item, naming the failing index), the same INJECTION_PATTERNS
 * sanitizer extract_facts output passes through, a 500-char cap, claim content
 * is NEVER executed, and provenance + client_authored are stamped per row so
 * downstream grading/consolidation can weight or quarantine.
 *
 * Config-free on purpose: the handler runs inside serve-http's tenant
 * withSourceScope tx under the NOBYPASSRLS gbrain_tenant role, which is
 * GRANT-excluded from the config table (CAT-6). A raw config read there aborts
 * the whole tx (the FLAG-C class). So this path reads no config — no kill
 * switch, no getConfig. isAvailable() reads the in-memory gateway config
 * (process env), not the DB, so it is safe.
 */

import { z } from 'zod';
import type { BrainEngine, NewFact, FactKind } from '../engine.ts';
import { sanitizeTakeForPrompt } from '../think/sanitize.ts';
import { scanRestrictedData, logRestrictedDrop } from './restricted-data.ts';
import { isAvailable, embedOne } from '../ai/gateway.ts';
import { cosineSimilarity } from './classify.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { slugifyEntity } from '../enrichment-service.ts';
import { constructGraphFromClaim } from './construct.ts';

/** Layer-1 (pg_trgm / normalized-exact) duplicate threshold. */
const TRGM_DEDUP_THRESHOLD = 0.85;
/** Layer-2 (cosine) duplicate threshold — matches classify.ts cheap fast-path. */
const COSINE_DEDUP_THRESHOLD = 0.95;
/** Candidate cap for the embedding-neighbor search. */
const EMBED_NEIGHBOR_K = 5;

/** One claim as the client sends it. `.strict()` rejects unknown keys. */
const ClaimSchema = z
  .object({
    claim: z.string().min(1).max(500),
    kind: z.enum(['fact', 'event', 'commitment', 'preference', 'belief']).optional(),
    people: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
    date_context: z.string().optional(),
    provenance: z.enum(['user_stated', 'model_inferred']),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

type ValidClaim = z.infer<typeof ClaimSchema>;

export interface SaveFactsContext {
  engine: BrainEngine;
  sourceId: string;
}

export type SaveFactsResult =
  | {
      // Whole-batch validation failure. No rows written. `failed_index` names
      // the offending claim (−1 = the top-level shape, e.g. not an array).
      error: 'invalid_claim' | 'invalid_batch';
      failed_index: number;
      detail: string;
    }
  | {
      inserted: number;
      duplicate: number;
      /**
       * Claims dropped by the restricted-data scrub (PCI card / SSN /
       * credential). These are NOT inserted and NOT counted as duplicates;
       * the rest of the batch proceeds. Always present (0 when nothing was
       * dropped). The dropped value itself is never returned or logged.
       */
      dropped: number;
      fact_ids: number[];
      /**
       * Which dedup layers were active for this batch:
       *   'trgm'         — Layer 1 only (no embedding provider configured —
       *                    the production-box reality today).
       *   'cosine+trgm'  — both layers (an embedding key was present).
       */
      dedup_mode: 'trgm' | 'cosine+trgm';
    };

/** model_inferred is hard-capped at 0.7; user_stated defaults to 1.0. */
function resolveConfidence(c: ValidClaim): number {
  if (c.provenance === 'model_inferred') {
    return Math.min(c.confidence ?? 0.7, 0.7);
  }
  return c.confidence ?? 1.0;
}

/**
 * Fold the structured surface forms into the `context` column so nothing the
 * client captured is lost. entity_slug is resolved separately (see
 * primarySubject + resolvePrimaryEntitySlug in the insert loop) — this fold keeps
 * EVERY surface form recoverable even when the claim has no single primary
 * subject and entity_slug stays NULL.
 *
 * The same people[]/entities[] arrays ALSO drive the deterministic graph
 * construct (entity stub pages + co-occurrence edges) AFTER the row inserts —
 * see constructGraphFromClaim. That construct is LLM-free (pure slugify + SQL
 * upserts), so the graph is built with no entity-resolver inference.
 *
 * Surface forms are untrusted, so the assembled string passes through the same
 * sanitizer as the claim.
 */
function buildContext(c: ValidClaim): string | null {
  const parts: string[] = [];
  if (c.people && c.people.length) parts.push(`people: ${c.people.join(', ')}`);
  if (c.entities && c.entities.length) parts.push(`entities: ${c.entities.join(', ')}`);
  if (c.date_context) parts.push(`when: ${c.date_context}`);
  if (parts.length === 0) return null;
  const { text } = sanitizeTakeForPrompt(parts.join(' | '));
  return text || null;
}

/**
 * A claim's PRIMARY SUBJECT for entity_slug — the entity the claim is
 * principally ABOUT — or null only when the claim names no entity at all.
 *
 * Rule: the GRAMMATICAL SUBJECT, approximated by LEADING MENTION. Among the
 * claim's candidate entities (people[] ∪ entities[]), the one whose surface
 * form appears EARLIEST in the claim text is the subject. A single-clause
 * structured fact's grammatical subject is, in practice, the first entity it
 * names: "Boltline is trying to land a deal" is about Boltline; "Reggie Salas
 * is the founder of Boltline" is about Reggie; "Strider is a sportswear giant …
 * Selene's employer" is about Strider.
 *
 * This REPLACES the prior "exactly one person → that person, else single entity,
 * else NULL" rule, whose blind spot was company-about claims that co-mention a
 * person. The rule only ever looked at entities[] when people[] was empty — but
 * a company-about claim almost always names a person too ("Boltline … wants
 * Marcus's help"), so the company lost to the person (1 person) or the claim
 * dropped to NULL (2+ people). A sparse company like Boltline therefore never
 * accumulated facts at its own node and went dark in entity-keyed recall and in
 * search ranking, while only densely cross-referenced hubs surfaced — masking
 * the gap. Leading mention anchors each claim where it belongs and never drops
 * a claim that names an entity into the NULL consolidation/recall black hole.
 *
 * Type (person vs company) follows the array the winner came from, with
 * batch-wide person membership winning — a surface ever listed in people[] is a
 * person even where another claim lists it under entities[]. This is the SAME
 * typing constructGraphFromClaim applies, so a fact's entity_slug equals the
 * graph stub's slug by construction (resolvePrimaryEntitySlug + the construct
 * both mint via slugifyEntity(raw, type)).
 *
 * Fallbacks, in order: a claim with one candidate takes it. When no surface
 * form can be located in the claim text (surface ≠ spoken form, e.g. a
 * pronoun-only restatement), fall back to the first person, else the first
 * entity — never NULL while any candidate exists. NULL remains correct only
 * when the claim names no people and no entities (e.g. "the renovation budget
 * is 40k"). A subject longer than 200 chars isn't a name; skip it.
 *
 * Known edge: a fronted adverbial/prepositional phrase ("At Strider, Selene
 * leads marketing") makes the object the leading mention. The structured seed
 * corpus is subject-first, so this is rare, and it degrades to a genuinely
 * co-mentioned entity (a real, related node) — never to NULL.
 */
function primarySubject(
  c: ValidClaim,
  claimText: string,
  personSurfaceKeys: ReadonlySet<string> = new Set(),
): { raw: string; type: 'person' | 'company' } | null {
  type Candidate = { raw: string; type: 'person' | 'company' };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  // people first, then entities — fixes both the cap's truncation order and the
  // "first candidate wins on a positional tie" fallback below.
  const push = (raw: string, type: 'person' | 'company') => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // A "subject" longer than 200 chars isn't a name — skip it at intake so an
    // over-long surface can never win leading mention and force the whole claim
    // to NULL; a shorter, valid co-candidate still anchors the fact.
    if (trimmed.length > 200) return;
    const key = surfaceKey(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({ raw: trimmed, type });
  };
  for (const name of c.people ?? []) push(name, 'person');
  for (const name of c.entities ?? []) {
    push(name, personSurfaceKeys.has(surfaceKey(name)) ? 'person' : 'company');
  }

  if (candidates.length === 0) return null;

  let chosen: Candidate;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    const haystack = claimText.toLowerCase();
    let best: Candidate | null = null;
    let bestIdx = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const idx = earliestMention(haystack, cand.raw);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        best = cand;
      }
    }
    // No surface located in the text → first person, else first entity.
    chosen = best ?? candidates[0];
  }

  return chosen;
}

/**
 * Earliest case-insensitive, word-boundary occurrence of an entity surface form
 * in the (already-lowercased) claim text, or -1. Tries the full surface first,
 * then each whitespace token of length ≥ 3 — the seed lists full names
 * ("Reggie Salas") while claim text often uses the first name ("Reggie"), so
 * token matching is what makes leading mention fire. Word-boundary matching
 * stops a short token from matching inside an unrelated word ("line" inside
 * "Boltline", "pace" inside "space").
 */
function earliestMention(haystackLower: string, surface: string): number {
  const s = surface.toLowerCase().trim();
  if (!s) return -1;
  let best = -1;
  const consider = (needle: string) => {
    const idx = boundedIndexOf(haystackLower, needle);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  };
  consider(s);
  for (const token of s.split(/\s+/)) {
    if (token.length >= 3) consider(token);
  }
  return best;
}

/** indexOf, but the match must be flanked by non-alphanumeric chars (or ends). */
function boundedIndexOf(haystack: string, needle: string): number {
  if (!needle || needle.length > haystack.length) return -1;
  for (let from = 0; from <= haystack.length - needle.length; ) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return -1;
    const before = idx === 0 ? '' : haystack[idx - 1];
    const after = idx + needle.length >= haystack.length ? '' : haystack[idx + needle.length];
    if (!isAlphaNum(before) && !isAlphaNum(after)) return idx;
    from = idx + 1;
  }
  return -1;
}

function isAlphaNum(ch: string): boolean {
  return ch !== '' && /[a-z0-9]/.test(ch);
}

async function resolvePrimaryEntitySlug(
  engine: BrainEngine,
  sourceId: string,
  subject: { raw: string; type: 'person' | 'company' },
): Promise<string | null> {
  const resolved = await resolveEntitySlugWithSource(engine, sourceId, subject.raw);
  if (resolved === null) return null;
  if (resolved.source !== 'fallback_slugify') return resolved.slug;

  // When there is no existing page, save_facts and the graph construct must
  // agree on the new canonical slug. The construct mints typed fallback stubs
  // (`people/...` / `companies/...`), so stamp facts with that same slug up front.
  const slug = slugifyEntity(subject.raw, subject.type);
  const body = slug.slice(slug.indexOf('/') + 1);
  return body ? slug : null;
}

/**
 * Deterministic intake. Returns a validation error (no writes) or the insert
 * tally. Throws nothing in the normal path — the embedding lane is the only
 * external call and it is guarded + caught.
 *
 * Claims are processed SEQUENTIALLY so each one dedups against both the
 * source's existing facts AND the rows inserted earlier in this same batch
 * (same-tx read visibility) — a batch containing the same claim twice inserts
 * it once.
 */
export async function runSaveFacts(
  rawClaims: unknown,
  ctx: SaveFactsContext,
): Promise<SaveFactsResult> {
  // --- 1. validate (whole-batch reject, name the failing index) -----------
  if (!Array.isArray(rawClaims)) {
    return { error: 'invalid_batch', failed_index: -1, detail: 'claims must be an array' };
  }
  if (rawClaims.length === 0) {
    return { error: 'invalid_batch', failed_index: -1, detail: 'claims must be a non-empty array' };
  }
  // Validate AND sanitize in one pass, BEFORE any insert. A claim that
  // sanitizes to empty (whitespace/control-only) is rejected here exactly like
  // a schema failure, so a malformed item can never leak partial writes ahead
  // of itself. Each surviving claim carries its sanitized `cleaned` text
  // forward; the insert loop never re-sanitizes.
  const claims: Array<{ claim: ValidClaim; cleaned: string }> = [];
  let dropped = 0;
  for (let i = 0; i < rawClaims.length; i++) {
    const parsed = ClaimSchema.safeParse(rawClaims[i]);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path?.length ? first.path.join('.') : '(root)';
      return {
        error: 'invalid_claim',
        failed_index: i,
        detail: `claim[${i}].${path}: ${first?.message ?? 'invalid'}`,
      };
    }
    const { text } = sanitizeTakeForPrompt(parsed.data.claim);
    const cleaned = text.trim();
    if (!cleaned) {
      return {
        error: 'invalid_claim',
        failed_index: i,
        detail: `claim[${i}].claim: empty after sanitization`,
      };
    }
    // Restricted-data scrub (PCI card / SSN / credential). Distinct from the
    // whole-batch reject above: a well-formed claim that happens to carry
    // restricted data is DROPPED (kept out of `claims`, never inserted) while
    // the rest of the batch proceeds — partial save beats a hard error for a
    // memory tool. Conservative, high-signal only; the value is never logged.
    // See facts/restricted-data.ts.
    const restricted = scanRestrictedData(cleaned);
    if (restricted.restricted && restricted.category) {
      logRestrictedDrop(restricted.category, 'mcp:save_facts');
      dropped += 1;
      continue;
    }
    claims.push({ claim: parsed.data, cleaned });
  }

  // --- 2. batch-level capability: is the embedding lane configured? -------
  // In-memory gateway check (process env), never the DB config table. False on
  // the keyless production box → Layer 1 only, and we MUST NOT error for it.
  const embeddingsOn = isAvailable('embedding');
  const dedup_mode: 'trgm' | 'cosine+trgm' = embeddingsOn ? 'cosine+trgm' : 'trgm';
  const personSurfaceHints = collectPersonSurfaceHints(claims.map(({ claim }) => claim));
  const personSurfaceKeys = new Set(personSurfaceHints.map(surfaceKey).filter(Boolean));

  let inserted = 0;
  let duplicate = 0;
  const fact_ids: number[] = [];

  for (const { claim: c, cleaned } of claims) {
    // Claims were sanitized + emptiness-checked in the validation pass above;
    // `cleaned` is the trust-boundary-safe text. No re-sanitization here.

    // --- dedup -----------------------------------------------------------
    // Layer 1 (always on): normalized-exact OR pg_trgm near-dup.
    let matchedId: number | null = null;
    const textDups = await ctx.engine.findFactTextDuplicates(ctx.sourceId, cleaned, {
      threshold: TRGM_DEDUP_THRESHOLD,
    });
    if (textDups.length > 0) {
      matchedId = textDups[0].id;
    }

    // Layer 2 (conditional): cosine via embedding neighbors. Only when an
    // embedding provider is configured AND the claim embedded cleanly. The
    // embedding is reused for the insert below so future dedup/search work.
    let embedding: Float32Array | null = null;
    if (matchedId === null && embeddingsOn) {
      try {
        embedding = await embedOne(cleaned);
      } catch {
        // Embedding lane hiccup — degrade to Layer-1 result, never error.
        embedding = null;
      }
      if (embedding) {
        const neighbors = await ctx.engine.findFactEmbeddingNeighbors(ctx.sourceId, embedding, {
          k: EMBED_NEIGHBOR_K,
        });
        let topScore = -1;
        let topId: number | null = null;
        for (const n of neighbors) {
          if (!n.embedding) continue;
          const s = cosineSimilarity(embedding, n.embedding);
          if (s > topScore) {
            topScore = s;
            topId = n.id;
          }
        }
        if (topId !== null && topScore >= COSINE_DEDUP_THRESHOLD) {
          matchedId = topId;
        }
      }
    }

    if (matchedId !== null) {
      duplicate += 1;
      fact_ids.push(matchedId);
      continue;
    }

    // --- entity resolution (insert branch only — duplicates skip it) ------
    // Map the claim's primary subject to entity_slug through the SAME
    // deterministic resolver the read side uses (recall's entity branch,
    // operations.ts) and the extract write path uses (backstop.ts). Same
    // function on both sides of the seam means write format == query format
    // by construction, including the typed slugify fallback when no page matches.
    // The resolver is SQL-only (pages exact → pg_trgm fuzzy → prefix
    // expansion → slugify) — no LLM, no embedding, no config read — and
    // gbrain_tenant holds SELECT on all three tables it touches (pages,
    // links, content_chunks; b7-role.sql), so it is safe inside the tenant
    // withSourceScope tx. Subject strings are attacker-controlled but only
    // ever travel as parameterized SQL values; the written slug is either an
    // existing same-source page slug or typed slugify output
    // (people/[a-z0-9-] / companies/[a-z0-9-]).
    const subject = primarySubject(c, cleaned, personSurfaceKeys);
    const entitySlug = subject
      ? await resolvePrimaryEntitySlug(ctx.engine, ctx.sourceId, subject)
      : null;

    // --- insert (stamped) ------------------------------------------------
    const newFact: NewFact = {
      fact: cleaned,
      kind: (c.kind ?? 'fact') as FactKind,
      entity_slug: entitySlug,
      visibility: 'private',
      context: buildContext(c),
      source: 'mcp:save_facts',
      source_session: null,
      confidence: resolveConfidence(c),
      embedding,
      provenance: c.provenance,
      client_authored: true,
    };
    const result = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: save_facts is the deterministic structured-intake write surface — claims are pre-extracted by the client, there is no fence/markdown source to reconcile through
    fact_ids.push(result.id);
    if (result.status === 'inserted') {
      inserted += 1;
      // Deterministic graph construct (CC packet 2026-06-15, verdict B): turn
      // this claim's people[]/entities[] into entity stub pages + bidirectional
      // co-occurrence edges so traverse_graph / find_experts have a graph to
      // walk. Zero LLM, zero embedding — pure SQL upserts/inserts in this SAME
      // withSourceScope tx (same-tx visibility lets the edge batch see the
      // stubs written microseconds earlier). Runs only on a genuine insert: a
      // duplicate's canonical fact already built the identical graph. The fact
      // is the primary value, the graph is derived. See facts/construct.ts for
      // the tenant-plane discipline (low-level writes, config-free, source-scoped).
      await constructGraphFromClaim(ctx.engine, ctx.sourceId, {
        people: c.people,
        entities: c.entities,
        personSurfaceHints,
        claimText: cleaned,
      });
    } else {
      duplicate += 1; // engine-level dedup (advisory-lock race) — count as duplicate
    }
  }

  return { inserted, duplicate, dropped, fact_ids, dedup_mode };
}

function collectPersonSurfaceHints(claims: ValidClaim[]): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const name of claim.people ?? []) {
      const key = surfaceKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      hints.push(name);
    }
  }
  return hints;
}

function surfaceKey(name: string): string {
  return name.trim().toLowerCase();
}
