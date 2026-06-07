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
import { isAvailable, embedOne } from '../ai/gateway.ts';
import { cosineSimilarity } from './classify.ts';

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
 * client captured is lost, without resolving entities (which would need the
 * LLM/embedding entity resolver). entity_slug stays NULL — the claim text
 * itself carries the names as spoken, so pg_trgm dedup and grep/keyword recall
 * still work; entity-scoped recall is the deferred enhancement.
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
  const claims: ValidClaim[] = [];
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
    claims.push(parsed.data);
  }

  // --- 2. batch-level capability: is the embedding lane configured? -------
  // In-memory gateway check (process env), never the DB config table. False on
  // the keyless production box → Layer 1 only, and we MUST NOT error for it.
  const embeddingsOn = isAvailable('embedding');
  const dedup_mode: 'trgm' | 'cosine+trgm' = embeddingsOn ? 'cosine+trgm' : 'trgm';

  let inserted = 0;
  let duplicate = 0;
  const fact_ids: number[] = [];

  for (const c of claims) {
    // --- 3. sanitize (trust boundary) -------------------------------------
    const { text: factText } = sanitizeTakeForPrompt(c.claim);
    const cleaned = factText.trim();
    if (!cleaned) {
      // Sanitized to nothing (claim was whitespace/control-only) — treat as a
      // malformed item, reject the whole batch. No writes have happened: a
      // sanitize-to-empty can only occur before any insert for THIS claim, but
      // earlier claims in the batch may already be committed in the tx. We
      // still surface the index so the client can fix and resend; the tx-level
      // atomicity of the dispatch wrap decides commit/rollback.
      const idx = claims.indexOf(c);
      return { error: 'invalid_claim', failed_index: idx, detail: `claim[${idx}].claim: empty after sanitization` };
    }

    // --- 4. dedup --------------------------------------------------------
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

    // --- 5. insert (stamped) ---------------------------------------------
    const newFact: NewFact = {
      fact: cleaned,
      kind: (c.kind ?? 'fact') as FactKind,
      entity_slug: null,
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
    if (result.status === 'inserted') inserted += 1;
    else duplicate += 1; // engine-level dedup (advisory-lock race) — count as duplicate
  }

  return { inserted, duplicate, fact_ids, dedup_mode };
}
