/**
 * v0.32.2 — forget-as-fence path (Codex R2-#3).
 *
 * Before v0.32.2 `gbrain forget` and the MCP `forget_fact` op called
 * `engine.expireFact(id)` directly, which UPDATEs `facts.expired_at`
 * in the DB. After `gbrain rebuild` (v0.32.3) that DB-only mutation
 * would evaporate because the canonical markdown fence is unchanged
 * — the forget would un-happen.
 *
 * The fix: forget becomes a fence rewrite. Strike through the target
 * row's `claim` cell, set its `valid_until` to today, append
 * `forgotten: <reason>` to its `context` cell. On every rebuild the
 * extract-from-fence mapper re-derives `valid_until` AND (v0.42.24)
 * `expired_at` from the struck row, so the forget state survives.
 * (Older comments cited an "`expired_at = valid_until + now()` rule"
 * in the DB — that rule never existed; the mapper derivation is the
 * real mechanism.)
 *
 * Strikethrough parse contract (extends commit 2's two-mode design):
 *   `~~claim~~` + `context: superseded by #N`       → supersededBy=N
 *   `~~claim~~` + `context: superseded by fact #N`  → supersededByFactId=N
 *   `~~claim~~` + `context: forgotten: <reason>`    → forgotten=true
 *   `~~claim~~` + anything else                     → active=false; the
 *      mapper treats this as forgotten for DB-derivation purposes.
 *
 * v0.42.24 (FE-2 lossy-rewrite fix): the fence rewrite is now a
 * SURGICAL single-line replacement via `updateFactRowInFence` — every
 * byte the forget doesn't intend to touch (prose comments, hand-edit
 * typo rows, collision rows) is preserved verbatim. The pre-fix
 * implementation re-rendered the whole fence from the lenient parse,
 * silently erasing anything the parser dropped, and the validate gate
 * couldn't catch it because the re-render was already clean. The gate
 * is now "no NEW parse warnings": pre-existing fence damage neither
 * blocks the forget nor gets erased by it.
 *
 * Two-tier fallback for cross-state safety:
 *   1. If the target row has v51 columns (row_num + source_markdown_slug
 *      + sources.local_path), do the fence rewrite. The forget survives
 *      rebuild (`durable: true`).
 *   2. If any of those is missing, fall through to the legacy
 *      `engine.expireFact(id)` direct-DB path. A once-per-process
 *      stderr warning names the case so operators see the degraded
 *      mode. The result's `durable` flag is the honest per-call
 *      disclosure: rows with NO `source_markdown_slug` are never
 *      touched by the fence reconcile, so a DB-only forget of one IS
 *      durable; rows that ARE fence-backed but couldn't be rewritten
 *      (file deleted, row_num drift, validate failure) get
 *      `durable: false` — the next reconcile of that page resurrects
 *      the fact. Callers must surface that instead of implying the
 *      forget survives rebuild.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { parseFactsFence, updateFactRowInFence, introducesNewWarnings } from '../facts-fence.ts';

export interface ForgetFactResult {
  /** True iff the row was found AND a forget was applied (fence or DB). */
  ok: boolean;
  /** Discriminator on the path that handled the forget. */
  path: 'fence' | 'legacy_db' | 'not_found' | 'already_expired';
  /** Human-readable reason captured in `context`; mirrors back what was written. */
  reason: string;
  /**
   * v0.42.24 — honest durability disclosure. True when the forget
   * survives a rebuild/reconcile: either the fence was rewritten
   * (`path: 'fence'`) or the row is not fence-backed (NULL
   * `source_markdown_slug`, so the reconcile wipe never touches it).
   * False when the row IS fence-backed but only the DB was stamped —
   * the next `extract_facts` reconcile of that page will resurrect the
   * fact. Meaningful only when `ok` is true.
   */
  durable: boolean;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches extract-from-fence's helper. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * Forget a fact by id. Routes through the fence when the row carries
 * v51 columns + the source has a local_path; falls through to legacy
 * `expireFact` otherwise. Idempotent: returns `already_expired` when
 * the row's `expired_at` is already non-null.
 *
 * Reason defaults to `'forgotten'` when the caller doesn't provide one
 * (matches the existing `gbrain forget` CLI which takes no reason
 * argument). MCP `forget_fact` op can pass a more specific reason
 * when the user provides it.
 */
export async function forgetFactInFence(
  engine: BrainEngine,
  factId: number,
  opts: { reason?: string } = {},
): Promise<ForgetFactResult> {
  const reason = opts.reason ?? 'forgotten';

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at
       FROM facts WHERE id = $1`,
    [factId],
  );
  if (rows.length === 0) {
    return { ok: false, path: 'not_found', reason, durable: true };
  }
  const row = rows[0];

  // DB-only expire is durable iff the row is NOT fence-backed: the
  // reconcile wipe (`deleteFactsForPage`) keys on `source_markdown_slug`,
  // so NULL-slug rows are never re-minted from a fence.
  const dbOnlyDurable = row.source_markdown_slug === null;

  if (row.expired_at !== null) {
    return { ok: false, path: 'already_expired', reason, durable: true };
  }

  // Fence path requires: v51 columns set + source.local_path set.
  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null &&
    row.entity_slug !== null;

  if (!canFence) {
    // Legacy path — DB-only forget. Durable only for non-fence-backed rows.
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason, durable: dbOnlyDurable };
  }

  // Look up source.local_path.
  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [row.source_id],
  );
  const localPath = sources[0]?.local_path ?? null;
  if (!localPath) {
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason, durable: dbOnlyDurable };
  }

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;
  const filePath = join(localPath, `${slug}.md`);
  const tmpPath = `${filePath}.tmp`;

  if (!existsSync(filePath)) {
    // File deleted out from under us — only the DB has the row.
    // Legacy path is the safe behavior; the operator can fix the
    // tree mismatch separately.
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason, durable: dbOnlyDurable };
  }

  return withPageLock(slug, async () => {
    const body = readFileSync(filePath, 'utf-8');
    const preWarnings = parseFactsFence(body).warnings;

    // Mutate: strike out claim (already-strikethrough rows stay
    // strikethrough), set valid_until = today, append "forgotten:
    // <reason>" to context (preserving any existing context). The
    // separator is '; ' — NOT ' | ' — because a literal pipe in a cell
    // is exactly the escape-asymmetry corruption trigger (FE-4:
    // escape-on-write writes '\|' but the parser splits on every '|').
    const today = todayUtc();

    // Surgical single-line replacement. Null → the fence is missing the
    // row (DB drifted from markdown) or the row is hand-mangled beyond
    // parsing: fall through to legacy expire so the user's intent
    // succeeds; doctor surfaces the drift separately.
    const edit = updateFactRowInFence(body, targetRowNum, f => {
      const existingContext = f.context?.trim() ?? '';
      return {
        ...f,
        active: false,        // strikethrough on render
        validUntil: today,
        context: existingContext
          ? `${existingContext}; forgotten: ${reason}`
          : `forgotten: ${reason}`,
        forgotten: true,
      };
    });
    if (!edit) {
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db' as const, reason, durable: dbOnlyDurable };
    }

    // Atomic .tmp + parse-validate + rename. The gate is "no NEW
    // warnings": pre-existing fence damage is preserved (never erased —
    // that was FE-2) and doesn't block the forget; damage INTRODUCED by
    // this edit quarantines the .tmp and falls back to DB expire.
    writeFileSync(tmpPath, edit.body, 'utf-8');
    const tmpBody = readFileSync(tmpPath, 'utf-8');
    const postWarnings = parseFactsFence(tmpBody).warnings;
    if (introducesNewWarnings(preWarnings, postWarnings)) {
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db' as const, reason, durable: dbOnlyDurable };
    }
    renameSync(tmpPath, filePath);

    // Stamp the DB to match: valid_until = today, expired_at = now().
    // This keeps DB query patterns (active facts WHERE expired_at IS NULL)
    // accurate the moment the forget commits, without waiting for the
    // next extract_facts cycle phase to reconcile.
    // RETURNING source_id feeds the P1 query-cache invalidation: a
    // forgotten fact must also stop appearing in cached search results
    // (the legacy_db paths get this via engine.expireFact; this direct
    // stamp is the one forget executor that bypasses it).
    const stamped = await engine.executeRaw<{ source_id: string }>(
      `UPDATE facts SET valid_until = $1, expired_at = now()
       WHERE id = $2 AND expired_at IS NULL
       RETURNING source_id`,
      [today, factId],
    );
    const stampedSource = stamped?.[0]?.source_id;
    if (stampedSource) await engine.invalidateQueryCacheForFacts?.(stampedSource);

    return { ok: true, path: 'fence' as const, reason, durable: true };
  }, { timeoutMs: 5_000 });
}
