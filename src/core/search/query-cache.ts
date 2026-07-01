/**
 * Semantic Query Cache (v0.32.x — search-lite)
 *
 * Caches hybridSearch results keyed by query embedding similarity. On
 * each lookup the cache runs an HNSW cosine-distance probe against
 * stored query embeddings. If the closest cached query is within
 * `1 - similarity_threshold` cosine distance (default similarity
 * >= 0.92, distance < 0.08), we return the stored results instantly
 * — no keyword search, no vector search, no LLM expansion, no RRF, no
 * dedup. Otherwise we report a miss and let the caller run the real
 * search.
 *
 * Storage: the `query_cache` table (migration v51) with the same
 * embedding dim as `content_chunks`. Per-row TTL (default 3600 seconds).
 * Stale rows are skipped at read time and pruned by `gbrain cache prune`.
 *
 * Multi-source isolation: cache lookups scope by `source_id` so brain
 * A's "who is widget-ceo" cannot return brain B's cached results for
 * the same query.
 *
 * Edge cases:
 *   - No embedding available (no OPENAI key, embed failure): cache is
 *     skipped silently. Caller runs the normal pipeline.
 *   - Table missing (pre-v51 brain): every read swallows the error and
 *     reports a miss. No throw.
 *   - Cache disabled by config or by caller (`useCache: false`): the
 *     cache module is never called.
 *
 * Tested in test/query-cache.test.ts.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SearchResult, HybridSearchMeta } from '../types.ts';
import { buildPageGenerationsSnapshot, CACHE_GATE_WHERE_CLAUSE } from './query-cache-gate.ts';

/** Default cosine similarity threshold for cache hits. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
/** Default TTL for cache entries, in seconds. */
export const DEFAULT_TTL_SECONDS = 3600;

export interface CacheLookupResult {
  hit: boolean;
  results?: SearchResult[];
  meta?: HybridSearchMeta;
  /** Cosine similarity of the matched cached query (0..1). Only set on hit. */
  similarity?: number;
  /** Age of the cached entry in seconds. Only set on hit. */
  ageSeconds?: number;
}

export interface CacheStats {
  total_rows: number;
  total_hits: number;
  fresh_rows: number;
  stale_rows: number;
}

export interface QueryCacheConfig {
  enabled?: boolean;
  similarityThreshold?: number;
  ttlSeconds?: number;
}

/**
 * Deterministic ID for a (query, source, knobsHash) tuple. Used as the primary
 * key so re-caching the exact same (query, mode, knobs) just bumps the row's
 * hit_count and created_at rather than inserting duplicates.
 *
 * v0.32.3 [CDX-4]: knobsHash is now part of the key to prevent cross-mode
 * cache contamination. A tokenmax write (expansion=on, limit=50) and a
 * conservative write (no expansion, limit=10) for the same query+source
 * land in distinct rows. Empty-string knobsHash is accepted (preserves
 * existing test setups) but production calls always pass the resolved hash.
 */
export function cacheRowId(queryText: string, sourceId: string, knobsHash = ''): string {
  const h = createHash('sha256');
  h.update(`${sourceId}::${queryText}::${knobsHash}`);
  return h.digest('hex').slice(0, 32);
}

/**
 * Convert a Float32Array embedding into the pgvector text literal
 * format: `[v0,v1,v2,...]`. PGLite and Postgres both accept this when
 * the parameter is cast to `vector` or `halfvec` on the server side.
 */
function embeddingToPgVector(embedding: Float32Array): string {
  // Stringify with reasonable precision. pgvector accepts plain decimals.
  // Use a typed iteration to avoid TS errors on Float32Array forEach.
  const parts: string[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    parts[i] = embedding[i].toFixed(6);
  }
  return `[${parts.join(',')}]`;
}

export class SemanticQueryCache {
  private similarityThreshold: number;
  private ttlSeconds: number;
  private enabled: boolean;

  constructor(
    private engine: BrainEngine,
    config?: QueryCacheConfig,
  ) {
    this.enabled = config?.enabled ?? true;
    this.similarityThreshold = clampThreshold(config?.similarityThreshold);
    this.ttlSeconds = clampTtl(config?.ttlSeconds);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Look up a cached result set by query embedding similarity. Returns a
   * miss (hit=false) when:
   *   - cache is disabled,
   *   - embedding is null/empty,
   *   - the table doesn't exist (pre-v51 brain),
   *   - no row is within the similarity threshold,
   *   - the matching row is past its TTL.
   *
   * All errors are swallowed and converted to a miss \u2014 the cache must
   * never break the search hot path.
   */
  async lookup(
    queryEmbedding: Float32Array | null,
    opts: { sourceId?: string; knobsHash?: string; queryText?: string } = {},
  ): Promise<CacheLookupResult> {
    if (!this.enabled || !queryEmbedding || queryEmbedding.length === 0) {
      return { hit: false };
    }
    const sourceId = opts.sourceId ?? 'default';
    const knobsHash = opts.knobsHash ?? '';
    const queryTextNorm = normalizeCacheQueryText(opts.queryText);
    // Fail closed: without usable query text the text gate cannot apply, and
    // an embedding-only match is exactly the F5 collision class (one cached
    // row served to every nearby query). No text, no cache.
    if (queryTextNorm === null) return { hit: false };
    const distanceThreshold = 1 - this.similarityThreshold;
    const vec = embeddingToPgVector(queryEmbedding);

    try {
      // Find the closest cached query within the distance threshold and
      // freshness window. The TTL check is done in-query (created_at +
      // ttl_seconds > now) so we never return a stale row.
      //
      // v0.32.3 [CDX-4]: knobs_hash filter prevents cross-mode contamination.
      // A tokenmax write (expansion=on, limit=50) and a conservative read
      // (no expansion, limit=10) have distinct knobs hashes and miss each
      // other. Rows with NULL knobs_hash (pre-v0.32.3) are excluded.
      // v0.40.3.0: query_cache row aliased `qc` so the two-layer gate
      // fragment in CACHE_GATE_WHERE_CLAUSE can reference qc.max_generation_at_store
      // + qc.page_generations against the live pages table.
      const rows = await this.engine.executeRaw<{
        id: string;
        results: unknown;
        meta: unknown;
        distance: number;
        age_seconds: number;
      }>(
        `SELECT qc.id, qc.results, qc.meta,
                qc.embedding <=> $1::vector AS distance,
                EXTRACT(EPOCH FROM (now() - qc.created_at))::int AS age_seconds
         FROM query_cache qc
         WHERE qc.source_id = $2
           AND qc.knobs_hash = $4
           AND lower(btrim(qc.query_text, E' \t\r\n')) = $5
           AND qc.embedding IS NOT NULL
           AND qc.embedding <=> $1::vector < $3
           AND qc.created_at + (qc.ttl_seconds || ' seconds')::interval > now()
           AND ${CACHE_GATE_WHERE_CLAUSE}
         ORDER BY qc.embedding <=> $1::vector
         LIMIT 1`,
        [vec, sourceId, distanceThreshold, knobsHash, queryTextNorm],
      );

      if (rows.length === 0) return { hit: false };

      const row = rows[0];
      const results = Array.isArray(row.results)
        ? (row.results as SearchResult[])
        : safeJsonParse<SearchResult[]>(row.results, []);
      const meta = safeJsonParse<HybridSearchMeta | undefined>(row.meta, undefined);
      const similarity = 1 - row.distance;

      // Bump hit_count / last_hit_at \u2014 best-effort.
      void this.bumpHit(row.id).catch(() => { /* swallow */ });

      return {
        hit: true,
        results,
        meta,
        similarity,
        ageSeconds: row.age_seconds,
      };
    } catch {
      // Table missing, vector column missing, or any other failure: miss.
      return { hit: false };
    }
  }

  /**
   * Persist a fresh search result set into the cache. Idempotent on
   * (query_text + source_id) \u2014 re-writes the row with a fresh
   * created_at. Best-effort: errors are swallowed.
   */
  async store(
    queryText: string,
    queryEmbedding: Float32Array | null,
    results: SearchResult[],
    meta: HybridSearchMeta,
    opts: { sourceId?: string; ttlSeconds?: number; knobsHash?: string } = {},
  ): Promise<void> {
    if (!this.enabled || !queryEmbedding || queryEmbedding.length === 0) return;
    const sourceId = opts.sourceId ?? 'default';
    const knobsHash = opts.knobsHash ?? '';
    const ttl = clampTtl(opts.ttlSeconds ?? this.ttlSeconds);
    const id = cacheRowId(queryText, sourceId, knobsHash);
    const vec = embeddingToPgVector(queryEmbedding);

    // v0.40.3.0: capture the per-page snapshot + corpus-state bookmark
    // for the two-layer cache gate. Pure helper from query-cache-gate.ts
    // handles the pre-v91 brain fallback (empty snapshot, zero bookmark
    // \u2014 legacy compat preserved).
    const pageIds = results
      .map((r) => r.page_id)
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
    const snapshot = await buildPageGenerationsSnapshot(this.engine, pageIds);

    try {
      // v0.32.3 [CDX-4]: knobs_hash threaded into the row so concurrent
      // tokenmax + conservative writes for the same query+source live as
      // distinct rows. The PK is `id` (which already encodes the hash),
      // so ON CONFLICT (id) DO UPDATE just refreshes the same-mode row.
      //
      // v0.40.3.0: page_generations JSONB + max_generation_at_store BIGINT
      // stamped per D11 (cache invalidation gate); pre-v91 brains store an
      // empty `{}` + zero bookmark (legacy compat per the v0.40.3.0 IRON-RULE).
      //
      // page_generations ($9) is bound as a RAW OBJECT (NOT JSON.stringify'd)
      // into the $9::jsonb cast. The object-positional contract — postgres.js
      // unsafe(sql, params) / PGLite db.query(sql, params), same path as
      // executeRawJsonb — encodes a JS object to a proper JSONB OBJECT. Passing
      // JSON.stringify(...) instead double-encodes it into a JSONB STRING SCALAR
      // on postgres.js (PGLite hides it), and the gate's jsonb_each(page_generations)
      // then throws "cannot call jsonb_each on a non-object" on a cache MISS,
      // aborting the dispatch tx → brain_unavailable. results/meta ($6/$7) stay
      // JSON.stringify'd: they are double-encoded too but consumed only in JS via
      // safeJsonParse (never by in-SQL jsonb_each), so the shape is harmless there.
      // ONLY $9's encoding changes here.
      //
      // v0.40.6 (B7 tenant query_cache fix): wrap the INSERT in
      // engine.transaction() so a failed cache write cannot abort the
      // request. On the customer plane this write runs inside serve-http's
      // withSourceScope dispatch tx; a raw INSERT that trips the query_cache
      // RLS WITH CHECK (or any other error) raises 25P02 and POISONS that
      // outer tx — every later statement dies and the op returns
      // brain_unavailable (the try/catch below does NOT save it; the Postgres
      // abort outlives the swallowed JS error — same mechanism documented in
      // loadCacheConfig's B7 fix #4 chokepoint comment). engine.transaction()
      // is re-entrant: a real tx at top level (CLI/eval), a SAVEPOINT when
      // already inside the dispatch tx — so the failure rolls back to the
      // savepoint and the outer tx survives. Best-effort is now real.
      await this.engine.transaction((tx) =>
        tx.executeRaw(
        `INSERT INTO query_cache (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, page_generations, max_generation_at_store, created_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, now())
         ON CONFLICT (id) DO UPDATE SET
           query_text = EXCLUDED.query_text,
           knobs_hash = EXCLUDED.knobs_hash,
           embedding  = EXCLUDED.embedding,
           results    = EXCLUDED.results,
           meta       = EXCLUDED.meta,
           ttl_seconds = EXCLUDED.ttl_seconds,
           page_generations = EXCLUDED.page_generations,
           max_generation_at_store = EXCLUDED.max_generation_at_store,
           created_at  = now()`,
        [
          id,
          queryText,
          sourceId,
          knobsHash,
          vec,
          JSON.stringify(results),
          JSON.stringify(meta),
          ttl,
          // Raw object (NOT JSON.stringify) → $9::jsonb stores a proper JSONB
          // object via the object-positional contract. See comment above.
          snapshot.page_generations,
          snapshot.max_generation_at_store,
        ],
      ));
    } catch {
      // swallow \u2014 cache write must never break the search hot path.
      // With the engine.transaction() wrapper above, a nested failure has
      // already rolled back to its SAVEPOINT, so the caller's (dispatch) tx
      // is intact; this catch just absorbs the re-thrown error.
    }
  }

  /** Clear ALL cache rows (optionally scoped by source). Returns rows deleted. */
  async clear(opts: { sourceId?: string } = {}): Promise<number> {
    try {
      if (opts.sourceId) {
        const rows = await this.engine.executeRaw<{ n: number }>(
          `WITH deleted AS (DELETE FROM query_cache WHERE source_id = $1 RETURNING 1)
           SELECT COUNT(*)::int AS n FROM deleted`,
          [opts.sourceId],
        );
        return rows[0]?.n ?? 0;
      }
      const rows = await this.engine.executeRaw<{ n: number }>(
        `WITH deleted AS (DELETE FROM query_cache RETURNING 1)
         SELECT COUNT(*)::int AS n FROM deleted`,
      );
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Delete only stale (past-TTL) rows. Returns rows deleted. */
  async prune(): Promise<number> {
    try {
      const rows = await this.engine.executeRaw<{ n: number }>(
        `WITH deleted AS (
           DELETE FROM query_cache
           WHERE created_at + (ttl_seconds || ' seconds')::interval <= now()
           RETURNING 1
         )
         SELECT COUNT(*)::int AS n FROM deleted`,
      );
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Summary stats for `gbrain cache stats`. */
  async stats(): Promise<CacheStats> {
    try {
      const rows = await this.engine.executeRaw<{
        total_rows: number;
        total_hits: number;
        fresh_rows: number;
        stale_rows: number;
      }>(
        `SELECT
           COUNT(*)::int AS total_rows,
           COALESCE(SUM(hit_count), 0)::int AS total_hits,
           COUNT(*) FILTER (WHERE created_at + (ttl_seconds || ' seconds')::interval > now())::int AS fresh_rows,
           COUNT(*) FILTER (WHERE created_at + (ttl_seconds || ' seconds')::interval <= now())::int AS stale_rows
         FROM query_cache`,
      );
      return rows[0] ?? { total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0 };
    } catch {
      return { total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0 };
    }
  }

  private async bumpHit(id: string): Promise<void> {
    await this.engine.executeRaw(
      `UPDATE query_cache
         SET hit_count = hit_count + 1, last_hit_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}

function clampThreshold(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SIMILARITY_THRESHOLD;
  return Math.max(0.5, Math.min(0.999, v));
}

function clampTtl(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_TTL_SECONDS;
  // Cap at 30 days to avoid runaway TTLs.
  return Math.min(60 * 60 * 24 * 30, Math.floor(v));
}

function normalizeCacheQueryText(queryText: string | undefined): string | null {
  if (typeof queryText !== 'string') return null;
  const normalized = queryText.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resolve cache config from the engine's `config` table. Mirrors how
 * other modules read runtime config (e.g. embedding_dimensions). All
 * three keys have sensible defaults; missing rows fall back to those.
 */
export async function loadCacheConfig(engine: BrainEngine): Promise<QueryCacheConfig> {
  const config: QueryCacheConfig = {
    enabled: true,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  try {
    // B7 first-light fix #4 (close-the-class): route through the guarded
    // engine.getConfig chokepoint instead of a raw `SELECT … FROM config`.
    // On the customer-plane tenant role config is CAT-6 (GRANT-EXCLUDED), so a
    // raw read throws "permission denied for table config" and ABORTS the
    // withSourceScope dispatch tx — the try/catch here does NOT save it (the
    // Postgres abort outlives the swallowed JS error). getConfig returns null
    // for that role; semantics are identical (missing key → default).
    const [enabled, threshold, ttl] = await Promise.all([
      engine.getConfig('search.cache.enabled'),
      engine.getConfig('search.cache.similarity_threshold'),
      engine.getConfig('search.cache.ttl_seconds'),
    ]);
    if (enabled !== null) {
      config.enabled = enabled === '1' || enabled.toLowerCase() === 'true';
    }
    if (threshold !== null) {
      const v = parseFloat(threshold);
      if (Number.isFinite(v)) config.similarityThreshold = clampThreshold(v);
    }
    if (ttl !== null) {
      const v = parseInt(ttl, 10);
      if (Number.isFinite(v)) config.ttlSeconds = clampTtl(v);
    }
  } catch {
    // Use defaults.
  }
  return config;
}
