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
import {
  scanRestrictedData,
  logRestrictedDrop,
  scrubSurfaceForms,
  logRestrictedSurfaceStrip,
  type RestrictedCategory,
} from './restricted-data.ts';
import { isAvailable, embedOne } from '../ai/gateway.ts';
import { embedBatch, currentEmbeddingSignature } from '../embedding.ts';
import { cosineSimilarity } from './classify.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { slugifyEntity } from '../enrichment-service.ts';
import { constructGraphFromClaim, materializeEntityPages } from './construct.ts';
import { supersedeFactDurably } from './supersede.ts';

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
    /**
     * FIX 2 (import dates, PACKET ENGINE-PREP 2026-07-20): the SOURCE date of
     * this claim — the historical date it was true / stated, NOT the import
     * timestamp. 'YYYY-MM-DD' or full ISO. Optional; when a client re-saves an
     * imported conversation it stamps the original conversation date here so the
     * fact reads / decays / time-travels as of THEN, not now. Distinct from
     * `date_context` (free-text "when" that flows into the context column, never
     * a queryable date). A garbage or future value is ignored and the row falls
     * back to now() — a malformed date must never fail the batch. Threaded into
     * NewFact.valid_from below; facts.valid_from already exists (no migration).
     */
    valid_from: z.string().optional(),
    provenance: z.enum(['user_stated', 'model_inferred']),
    confidence: z.number().min(0).max(1).optional(),
    /**
     * B2 correction: the id of a PRIOR fact this claim replaces. When present,
     * the target row is expired (expired_at set) and superseded_by-linked to
     * the canonical replacement — atomically on the insert path (the engine's
     * insert+expire tx, so no observer ever sees both rows active). The engine
     * already supersedes natively; this is the one field that makes it reachable
     * from the customer plane. Optional; omit for a plain save. Positive integer
     * (facts.id is a serial). A claim can only supersede a DIFFERENT fact — the
     * loop guards self-supersession.
     */
    supersedes: z.number().int().positive().optional(),
  })
  .strict();

type ValidClaim = z.infer<typeof ClaimSchema>;

export interface SaveFactsContext {
  engine: BrainEngine;
  sourceId: string;
}

/**
 * B3: one claim's outcome, tagged with its position in the REQUEST array.
 *   'inserted'  — a new row was written; fact_id is its id. A superseding
 *                 insert (B2) also reports 'inserted' — it IS a new row; the
 *                 batch `superseded` counter + recall(supersessions:true)
 *                 report the chain.
 *   'duplicate' — no new row; fact_id is the CANONICAL existing row the claim
 *                 matched (dedup Layer 1/2, or the engine's advisory-lock race).
 *   'duplicate_superseded' — N1 (Option A): no new row; the claim's text
 *                 matches a fact expired BY CORRECTION (superseded_by set).
 *                 fact_id is the LIVE HEAD of the supersession chain
 *                 (bounded walk); superseded_from is the matched tombstone.
 *                 Counts under the batch `duplicate` tally.
 *   'dropped'   — restricted-data scrub (PCI card / SSN / credential); the
 *                 claim was never inserted. Carries the `category` ONLY —
 *                 the value itself is never returned or logged, but the
 *                 category is reported honestly so the caller can tell the
 *                 user WHY the memory was refused instead of losing it silently.
 */
export type SaveFactsClaimResult =
  | {
      index: number;
      status: 'inserted' | 'duplicate';
      fact_id: number;
      /**
       * B2 durability disclosure (v0.42.24 wiring): present ONLY when this
       * claim carried `supersedes` and the durable-supersede route could NOT
       * make the correction survive a fence reconcile (facts/supersede.ts
       * returned durable:false — a fence-backed target whose fence couldn't
       * be struck). The correction IS applied in the DB now; the next
       * extract_facts reconcile of that page resurrects it, and the caller
       * must not imply otherwise. Absent on every durable outcome, so
       * already-green receipts stay byte-identical.
       */
      supersede_durable?: false;
      /** Present iff supersede_durable is — names why the fence wasn't struck. */
      supersede_reason?: string;
    }
  | {
      /**
       * N1: replaying corrected-away text (MCP retry after an interleaved
       * correction, stale-export replay, a stale agent context window) is
       * refused honestly instead of minting a silent live resurrection.
       * Escape hatch: carry `supersedes` (the live head id) to re-assert
       * deliberately — the claim then skips the tombstone check entirely and
       * re-mints through the atomic insert+expire path with the chain intact.
       * Rows expired by forget/decay (superseded_by NULL) never produce this
       * status — deliberate deletion stays reversible by a plain save.
       */
      index: number;
      status: 'duplicate_superseded';
      fact_id: number;
      superseded_from: number;
    }
  | { index: number; status: 'dropped'; category: RestrictedCategory };

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
      /**
       * B2 supersessions applied this batch: a PRIOR fact expired and pointed
       * (superseded_by) at its replacement because a claim carried `supersedes`.
       * Always present (0 when no claim asked to supersede).
       *
       * Counting is honest on the dedup path (the correction's text already
       * existed, so the target is superseded via the durable route —
       * facts/supersede.ts, which strikes fence-backed targets in their fence
       * and stamps the DB — counted iff `applied`; unknown / foreign /
       * already-expired targets no-op, so a correction-batch retry never
       * re-counts). On the INSERT path it counts an atomic insert+expire the
       * engine DISPATCHED against an in-source target; an invalid / foreign /
       * already-expired target is a safe no-op on the old row (RLS + the
       * engine's `expired_at IS NULL` guard) while the new fact still
       * inserts, and the atomic path does not report whether the old row was
       * touched. Non-durable outcomes (the fence couldn't be struck) are
       * disclosed per-claim via `supersede_durable: false` on `results`.
       * Authoritative supersession state is always readable via
       * recall(supersessions: true).
       */
      superseded: number;
      fact_ids: number[];
      /**
       * B3: per-claim outcomes — EXACTLY one entry per input claim, ordered by
       * `index` (the claim's position in the request array). This is the
       * alignment-safe receipt: `fact_ids` carries no entry for a dropped
       * claim, so a positional zip of fact_ids against the request breaks
       * whenever dropped > 0 — `results` never does. Always present.
       */
      results: SaveFactsClaimResult[];
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
 * FIX 2 (import dates): parse a client-supplied `valid_from` into the fact's
 * historical valid-from Date. Fail-OPEN and deterministic (zero inference):
 *   - unparseable ('last Tuesday-ish') → undefined → engine defaults now(). A
 *     malformed date must NEVER fail the batch or lose the memory.
 *   - future-dated (beyond a small clock-skew tolerance) → undefined → now().
 *     Backdating is the whole point of importing history and is allowed; FORWARD
 *     dating is the dangerous direction (it skews decay + trajectory ordering),
 *     so it is refused rather than trusted.
 *   - absurd past (before 1990) → undefined → now().
 * Lenient shape parse matches extract-from-fence.ts (accept 'YYYY-MM-DD' or full
 * ISO). The value is only ever a parameterized timestamp — no injection surface.
 */
const VALID_FROM_FLOOR_MS = Date.UTC(1990, 0, 1);
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
function resolveValidFrom(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return undefined;
  if (ms > Date.now() + CLOCK_SKEW_MS) return undefined; // forward-dating → now()
  if (ms < VALID_FROM_FLOOR_MS) return undefined;        // absurd past → now()
  return d;
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
 * FIX 1 (RED-B, PACKET ENGINE-PREP 2026-07-20): resolve a superseded target
 * fact's OWN entity_slug so the post-loop materialize rebuilds its page. On a
 * cross-subject correction (Google→Meta) the old fact's slug differs from the
 * new claim's, so the old page would otherwise keep its stale chunk. RLS-safe
 * (source-scoped); expiring a row does not clear its entity_slug, so reading it
 * after the supersede is correct.
 */
async function resolveSupersededEntitySlug(
  engine: BrainEngine,
  factId: number,
  sourceId: string,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ entity_slug: string | null }>(
    `SELECT entity_slug FROM facts WHERE id = $1 AND source_id = $2`,
    [factId, sourceId],
  );
  return rows[0]?.entity_slug ?? null;
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
  const claims: Array<{ claim: ValidClaim; cleaned: string; index: number }> = [];
  // B3: per-claim receipt, assigned by REQUEST index. Every non-error path
  // fills every slot exactly once — a claim is either dropped here in
  // validation or reaches the insert loop below — so the array comes out
  // dense and index-ordered with no sort. (A whole-batch validation failure
  // returns the error shape before this is ever surfaced.)
  const results: SaveFactsClaimResult[] = new Array(rawClaims.length);
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
      // B3: honest drop receipt — the category class only, never the value.
      results[i] = { index: i, status: 'dropped', category: restricted.category };
      dropped += 1;
      continue;
    }
    // B4: the claim TEXT passed the restricted scan above, but the STRUCTURED
    // SURFACE FORMS (people/entities/date_context) were not scanned — yet they
    // flow into the `context` column, entity_slug resolution, AND the
    // co-occurrence graph. A card/SSN/credential in entities[] would otherwise
    // be banked verbatim (an SSN could even become an entity page slug + graph
    // node). Unlike the text path (drop the whole claim) we STRIP the offending
    // surface form and KEEP the claim — a co-mention is not worth a whole
    // memory. Every downstream reader (buildContext, primarySubject,
    // constructGraphFromClaim, collectPersonSurfaceHints) sees the scrubbed
    // arrays because they all read this same claim object.
    const surfaceScrub = scrubSurfaceForms(parsed.data);
    let claim: ValidClaim = parsed.data;
    if (surfaceScrub.stripped.length > 0) {
      for (const cat of surfaceScrub.stripped) {
        logRestrictedSurfaceStrip(cat, 'mcp:save_facts');
      }
      claim = {
        ...parsed.data,
        people: surfaceScrub.people,
        entities: surfaceScrub.entities,
        date_context: surfaceScrub.date_context,
      };
    }
    claims.push({ claim, cleaned, index: i });
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
  let superseded = 0;
  const fact_ids: number[] = [];
  // Entity slugs that received a NEW fact this batch — the set whose pages must
  // be (re)materialized from their facts after the loop (Layer 1, search_brain).
  const touchedEntitySlugs = new Set<string>();

  for (const { claim: c, cleaned, index } of claims) {
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

    // B2 correction target: the prior fact this claim replaces, or null when
    // the client didn't ask for a supersede. A claim can only supersede a
    // DIFFERENT fact — never the row it just deduped/inserted to, since
    // expiring the canonical row and pointing superseded_by at itself would
    // corrupt the chain (guarded per-branch below).
    const supersedeTargetId = typeof c.supersedes === 'number' ? c.supersedes : null;

    if (matchedId !== null) {
      // duplicate+supersedes → still apply the supersede, DURABLY (v0.42.24):
      // the correction's text already exists as canonical row `matchedId`, so
      // no new row is written; supersedeFactDurably expires the target and —
      // for fence-backed targets — strikes the fence row so the supersession
      // survives the extract_facts reconcile (the resurrection class the bare
      // expireFact here used to reopen). RLS-confined + idempotent: a target
      // in another tenant, already expired, or unknown is a silent no-op
      // (applied: false → not counted; a correction-batch retry neither
      // re-counts nor re-strikes the fence). Self-supersession (target ===
      // the canonical dup) is skipped.
      let supersedeDisclosure: { supersede_durable?: false; supersede_reason?: string } = {};
      if (supersedeTargetId !== null && supersedeTargetId !== matchedId) {
        const res = await supersedeFactDurably(ctx.engine, supersedeTargetId, {
          supersededByFactId: matchedId,
          sourceId: ctx.sourceId,
        });
        if (res.applied) superseded += 1;
        if (res.applied) {
          // FIX 1 (RED-B): the superseded target's OWN entity page must be
          // rebuilt so the corrected-away value stops surfacing via the chunk
          // arm. On the dedup path no new row inserts, so touchedEntitySlugs
          // would otherwise be empty for this claim; the target's slug may also
          // differ from this claim's (cross-subject correction). Post-loop
          // materialize then rebuilds it (or blanks it when it has no facts left).
          const oldSlug = await resolveSupersededEntitySlug(ctx.engine, supersedeTargetId, ctx.sourceId);
          if (oldSlug) touchedEntitySlugs.add(oldSlug);
        }
        if (res.applied && !res.durable) {
          // Honest receipt: the correction applies NOW, but the target's
          // fence still lists the claim active — the next reconcile of that
          // page resurrects it. Say so instead of implying durability.
          supersedeDisclosure = {
            supersede_durable: false,
            supersede_reason: res.reason ?? 'fence not rewritten',
          };
        }
      }
      duplicate += 1;
      fact_ids.push(matchedId);
      results[index] = { index, status: 'duplicate', fact_id: matchedId, ...supersedeDisclosure };
      continue;
    }

    // --- N1 tombstone check (third dedup layer, active-miss only) ----------
    // Exact-text lookup against rows expired BY CORRECTION (superseded_by IS
    // NOT NULL), firing whenever Layers 1+2 missed. The escape hatch is
    // HEAD-CHECKED (V-N1-2): a re-assertion passes through ONLY when its
    // `supersedes` names the chain's LIVE HEAD — the shape the tool doc has
    // always prescribed — and re-mints via the atomic insert+expire with the
    // chain intact. Any other `supersedes` (a stale correction batch
    // replayed after a FURTHER correction names a mid-chain id) gets the
    // same honest refusal as a plain replay: without the head check, that
    // replay re-minted the middle claim as live truth beside the real head.
    // Forget/decay tombstones (superseded_by NULL) never match, so deliberate
    // deletion stays reversible by a plain save. Refuse ONLY when the chain
    // walk lands on an ACTIVE head — the receipt then points at live truth;
    // a dead chain (the correction was itself forgotten) mints, or the
    // forget would become sticky against the original text.
    {
      const tomb = await ctx.engine.findSupersededTombstone(ctx.sourceId, cleaned);
      if (tomb !== null && tomb.head_active && supersedeTargetId !== tomb.head_id) {
        duplicate += 1;
        fact_ids.push(tomb.head_id);
        results[index] = {
          index,
          status: 'duplicate_superseded',
          fact_id: tomb.head_id,
          superseded_from: tomb.tombstone_id,
        };
        continue;
      }
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
      // FIX 2 (import dates): stamp the claim's SOURCE date when supplied +
      // parseable; undefined falls through to the engine default now() (both
      // engines: `input.valid_from ?? new Date()`), so unchanged for every
      // caller that omits it.
      valid_from: resolveValidFrom(c.valid_from),
    };
    // B2: when the claim supersedes a prior fact AND its text is not a dup, use
    // the engine's ATOMIC insert+expire path (its own tx) so no observer ever
    // sees the old and new rows both active — returns status 'superseded' iff
    // the expire actually applied (FS-3). A supersedeTargetId CAN equal the id
    // the INSERT is about to mint (future-id guess hitting the serial); the
    // engine's expire excludes the new row's own id (FS-5), so that shape lands
    // as a plain honest insert. Plain insert otherwise.
    const insertCtx = supersedeTargetId !== null
      ? { source_id: ctx.sourceId, supersedeId: supersedeTargetId }
      : { source_id: ctx.sourceId };
    const result = await ctx.engine.insertFact(newFact, insertCtx); // gbrain-allow-direct-insert: save_facts is the deterministic structured-intake write surface — claims are pre-extracted by the client, there is no fence/markdown source to reconcile through
    fact_ids.push(result.id);
    // 'superseded' means the engine wrote a NEW row (and atomically expired the
    // target) — count it as an insert exactly like 'inserted', and additionally
    // tally the supersession.
    if (result.status === 'inserted' || result.status === 'superseded') {
      inserted += 1;
      let supersedeDisclosure: { supersede_durable?: false; supersede_reason?: string } = {};
      if (result.status === 'superseded' && supersedeTargetId !== null) {
        superseded += 1;
        // v0.42.24 fence follow-up: the atomic tx above stamped the DB; this
        // DECLARED follow-up (followUp: true) strikes the target's fence row
        // so the supersession survives the extract_facts reconcile, and
        // discloses when it can't. Counting stays on the dispatch above
        // (`superseded` semantics unchanged); the follow-up contributes
        // durability + disclosure only. Non-fence-backed targets are a
        // durable db_only no-op inside the module.
        const followUp = await supersedeFactDurably(ctx.engine, supersedeTargetId, {
          supersededByFactId: result.id,
          followUp: true,
          sourceId: ctx.sourceId,
        });
        if (followUp.applied && !followUp.durable) {
          supersedeDisclosure = {
            supersede_durable: false,
            supersede_reason: followUp.reason ?? 'fence not rewritten',
          };
        }
        // FIX 1 (RED-B): on a CROSS-SUBJECT correction (old fact → companies/google,
        // new fact → companies/meta) the atomic insert+expire above added only the
        // NEW fact's slug to touchedEntitySlugs (below, at the entitySlug add).
        // Add the OLD target's slug too, so its page is rebuilt (or blanked when it
        // has no active facts left) and the corrected-away value stops surfacing
        // via the chunk arm. Same-subject corrections resolve to the same slug and
        // the Set dedups.
        const oldSlug = await resolveSupersededEntitySlug(ctx.engine, supersedeTargetId, ctx.sourceId);
        if (oldSlug) touchedEntitySlugs.add(oldSlug);
      }
      // B3: a superseding insert is still a NEW row → 'inserted' (the batch
      // `superseded` counter reports the chain; see SaveFactsClaimResult).
      results[index] = { index, status: 'inserted', fact_id: result.id, ...supersedeDisclosure };
      // Deterministic graph construct (CC packet 2026-06-15, verdict B): turn
      // this claim's people[]/entities[] into entity stub pages + bidirectional
      // co-occurrence edges so traverse_graph / find_experts have a graph to
      // walk. Zero LLM, zero embedding — pure SQL upserts/inserts. Runs only
      // on a genuine insert: a duplicate's canonical fact already built the
      // identical graph. The fact is the primary value, the graph is derived.
      // See facts/construct.ts for the tenant-plane discipline (low-level
      // writes, config-free, source-scoped).
      //
      // FS-7 (A2 2026-07-18): DERIVED-layer containment, same shape as the
      // FS-2 materialize guard below. Unwrapped, a graph SQL error aborted
      // the tenant dispatch tx (25P02 → the whole batch's PRIMARY writes
      // rolled back over a derived-graph hiccup), and on the operator
      // auto-commit plane it threw past claims 1..k-1's durably-committed
      // facts, losing the receipt for work already done. The savepoint/tx
      // wrap (engine.transaction — savepoint inside the dispatch tx, real tx
      // at top level) keeps same-tx stub→edge visibility while containing a
      // failure to the graph writes; the facts commit, the receipt stays
      // true, and the next save re-runs the idempotent upserts.
      try {
        await ctx.engine.transaction((txEngine) =>
          constructGraphFromClaim(txEngine, ctx.sourceId, {
            people: c.people,
            entities: c.entities,
            personSurfaceHints,
            claimText: cleaned,
          }),
        );
      } catch (err) {
        console.error(`[save_facts] graph construct skipped for claim ${index}, fact saved (graph writes rolled back to their own savepoint/tx): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Anchor for the post-loop materialize: this fact's primary-subject page
      // must be rebuilt from its facts so search_brain's chunk arm sees the
      // substance (not the stub). entity_slug == page slug by construction.
      if (entitySlug) touchedEntitySlugs.add(entitySlug);
    } else {
      duplicate += 1; // engine-level dedup (advisory-lock race) — count as duplicate
      results[index] = { index, status: 'duplicate', fact_id: result.id };
    }
  }

  // --- Layer 1: materialize entity bodies from facts (search_brain) ---------
  // Rebuild each touched entity's compiled_truth from its OWN active facts and
  // re-chunk, so search_brain's chunk arm retrieves real fact substance instead
  // of the stub skeleton (the search_brain-empty root cause; see construct.ts).
  // Deterministic + LLM-free: a pure facts→markdown compile (no chat gateway,
  // which the tenant plane does not have). Chunk embeddings reuse the SAME
  // ZeroEntropy zembed-1 lane the facts above used (embeddingsOn-gated,
  // best-effort) — zero added model inference; keyword search works at once via
  // the search_vector trigger even when the embed lane is down. Runs in the
  // caller's withSourceScope tx (same-tx fact visibility, RLS-confined).
  if (touchedEntitySlugs.size > 0) {
    const embedChunks = embeddingsOn
      ? (texts: string[]) => embedBatch(texts)
      : undefined;
    const embeddingSignature = embeddingsOn ? currentEmbeddingSignature() : null;
    // Best-effort: materialization is the DERIVED layer — the facts (+ graph)
    // are the primary value. A materialize failure must NOT discard them on
    // EITHER plane, so the rebuild runs inside engine.transaction(), the
    // engine's plane-aware nesting primitive (postgres-engine.ts): a real
    // transaction at top level (operator/CLI auto-commit plane, where the
    // facts are already durably committed), a SAVEPOINT when already inside
    // the tenant withSourceScope dispatch tx. Either way a SQL error rolls
    // back ONLY the materialize writes and leaves the surrounding state
    // healthy, so the catch below can swallow honestly on both planes.
    //
    // FS-2 (engine audit 2026-07-17): before this guard, a materialize SQL
    // error on the tenant plane aborted the WHOLE dispatch tx (25P02). The
    // swallow let this function return its success tally, but postgres.js's
    // begin-scope error backstop (uncaughtError, postgres@3.4.9) re-threw the
    // swallowed query error after the op resolved — the caller received a
    // failure AND every fact in the batch was rolled back: a derived-layer
    // rebuild hiccup silently destroyed the batch's primary writes while this
    // log line claimed "facts saved". (On a driver without that backstop the
    // same shape fabricates a success receipt for rows that no longer exist.)
    // The savepoint contains the failure: the facts (+ graph stubs) commit,
    // the receipt is true, and a later save/cycle re-materializes — the
    // facts→body compile is idempotent over the fact set.
    try {
      await ctx.engine.transaction((txEngine) =>
        materializeEntityPages(txEngine, ctx.sourceId, touchedEntitySlugs, {
          embedChunks,
          embeddingSignature,
        }),
      );
    } catch (err) {
      console.error(`[save_facts] materialize skipped, facts saved (materialize writes rolled back to their own savepoint/tx): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { inserted, duplicate, dropped, superseded, fact_ids, results, dedup_mode };
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
