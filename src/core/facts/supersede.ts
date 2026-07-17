/**
 * v0.42.24 — durable supersede (fence-resurrection class, P0 #1 /
 * FS-1 ≡ FE-1).
 *
 * The B2 `save_facts` supersede used to be a DB-only status write:
 * `engine.expireFact(target, { supersededBy })` on the dedup path, and
 * the atomic insert+expire tx on the insert path. For targets whose
 * system of record is the markdown fence (rows with
 * `source_markdown_slug` set), the DB is a derived index — the next
 * `extract_facts` reconcile wipes the page's rows and re-mints them
 * FROM the fence, which never learned about the supersession. The
 * corrected-away claim came back active under a new id, the chain was
 * destroyed, and the `superseded: 1` receipt was retroactively
 * falsified. `forget.ts` fixed this exact class for forgets in
 * v0.32.2; this module is the supersede sibling.
 *
 * The durable path: strike the target's fence row (strikethrough
 * claim, `valid_until`, context marker `superseded by fact #<id>`),
 * then stamp the DB. On every rebuild the extract-from-fence mapper
 * re-derives `expired_at` + `superseded_by` from the struck row, so
 * the supersession survives. The id in the marker is the SUPERSEDING
 * fact's id — a DB-only row (NULL `source_markdown_slug`) whose id is
 * stable across rebuilds, unlike fence-backed ids which are re-minted.
 *
 * Honest fallback: when the fence can't be rewritten, the DB is still
 * stamped (the user's correction intent succeeds NOW) and the result
 * discloses durability:
 *   - `path: 'db_only'`, `durable: true` — the target is not
 *     fence-backed (NULL slug); the reconcile wipe never touches it,
 *     so the DB-only supersession genuinely survives rebuild. This is
 *     the common case for save_facts-authored targets.
 *   - `path: 'db_fallback'`, `durable: false` — the target IS
 *     fence-backed but the fence couldn't be struck (no local_path /
 *     file deleted / row_num drift / edit would corrupt the fence).
 *     The next reconcile of that page resurrects the claim. Callers
 *     MUST surface this instead of receipting a durable supersession.
 *
 * Follow-up mode: when the target is already expired WITH
 * `superseded_by` equal to `supersededByFactId`, this call is the
 * fence follow-up to the engine's atomic insert+expire path — the DB
 * stamp is skipped and only the fence is struck. Any other
 * already-expired target is a no-op (`applied: false`), mirroring
 * `expireFact`'s idempotent-as-false contract.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { parseFactsFence, updateFactRowInFence, introducesNewWarnings } from '../facts-fence.ts';

export interface SupersedeFactResult {
  /**
   * True iff the supersession is recorded (DB stamped and/or fence
   * struck). False for unknown / RLS-invisible / already-expired
   * targets — mirrors the `expireFact` no-op contract so callers can
   * keep counting `superseded` the same way.
   */
  applied: boolean;
  /** Which route recorded it. */
  path: 'fence' | 'db_only' | 'db_fallback' | 'not_found' | 'already_expired';
  /**
   * True when the supersession survives a rebuild/reconcile: the fence
   * was struck, or the target is not fence-backed. False means the DB
   * was stamped but the fence still lists the claim active — the next
   * `extract_facts` reconcile of that page resurrects it. Callers must
   * disclose that in the receipt rather than claim a durable
   * supersession.
   */
  durable: boolean;
  /** Present when the fence route was expected but fell back. */
  reason?: string;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
  superseded_by: string | number | null;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches forget.ts / extract-from-fence. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * Supersede a fact by id, durably when the target is fence-backed.
 *
 * Routing mirrors `forgetFactInFence`'s two-tier design; every failure
 * inside the fence route degrades to the DB stamp with an honest
 * `durable: false`, so this is never WORSE than the pre-v0.42.24
 * direct `expireFact` call — it only adds fence durability and
 * disclosure on top.
 */
export async function supersedeFactDurably(
  engine: BrainEngine,
  targetId: number,
  opts: { supersededByFactId: number },
): Promise<SupersedeFactResult> {
  const supersededByFactId = opts.supersededByFactId;

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, superseded_by
       FROM facts WHERE id = $1`,
    [targetId],
  );
  if (rows.length === 0) {
    // Unknown or RLS-invisible — silent no-op (matches the B2 contract:
    // a target in another tenant must not be observable).
    return { applied: false, path: 'not_found', durable: true };
  }
  const row = rows[0];

  const dbOnlyDurable = row.source_markdown_slug === null;

  // Already expired: only proceed when this call is the fence follow-up
  // to the engine's atomic insert+expire (superseded_by already points
  // at the superseding fact). Anything else is a no-op.
  const alreadyStamped =
    row.expired_at !== null && Number(row.superseded_by) === supersededByFactId;
  if (row.expired_at !== null && !alreadyStamped) {
    return { applied: false, path: 'already_expired', durable: true };
  }

  const stampDb = async (): Promise<boolean> => {
    if (alreadyStamped) return true;
    return engine.expireFact(targetId, { supersededBy: supersededByFactId }); // gbrain-allow-direct-insert: DB half of the durable supersede — the fence strike (or the honest durable:false disclosure) is handled by this module, unlike the pre-v0.42.24 bare expireFact
  };

  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null &&
    row.entity_slug !== null;

  if (!canFence) {
    const applied = await stampDb();
    return dbOnlyDurable
      ? { applied, path: 'db_only', durable: true }
      : {
          applied,
          path: 'db_fallback',
          durable: false,
          reason: 'fence-backed row missing v51 columns; fence not rewritten',
        };
  }

  let localPath: string | null = null;
  try {
    const sources = await engine.executeRaw<SourceRow>(
      `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
      [row.source_id],
    );
    localPath = sources[0]?.local_path ?? null;
  } catch {
    localPath = null;
  }
  if (!localPath) {
    const applied = await stampDb();
    return {
      applied,
      path: 'db_fallback',
      durable: false,
      reason: 'source has no local_path; fence not rewritten',
    };
  }

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;
  const filePath = join(localPath, `${slug}.md`);
  const tmpPath = `${filePath}.tmp`;

  if (!existsSync(filePath)) {
    const applied = await stampDb();
    return {
      applied,
      path: 'db_fallback',
      durable: false,
      reason: `fence file missing on disk (${slug}.md); fence not rewritten`,
    };
  }

  return withPageLock(slug, async () => {
    try {
      const body = readFileSync(filePath, 'utf-8');
      const preWarnings = parseFactsFence(body).warnings;
      const today = todayUtc();

      // Surgical single-line strike (FE-2 discipline: no whole-fence
      // re-render; untouched lines survive byte-for-byte). The context
      // marker uses '; ' as separator — a literal pipe in a cell is the
      // FE-4 escape-asymmetry corruption trigger. An explicit
      // valid_until already on the row is preserved (the claim's
      // temporal bound predates the correction); otherwise today.
      const edit = updateFactRowInFence(body, targetRowNum, f => {
        const existingContext = f.context?.trim() ?? '';
        const marker = `superseded by fact #${supersededByFactId}`;
        return {
          ...f,
          active: false,
          validUntil: f.validUntil ?? today,
          context: existingContext ? `${existingContext}; ${marker}` : marker,
          supersededByFactId,
        };
      });
      if (!edit) {
        const applied = await stampDb();
        return {
          applied,
          path: 'db_fallback' as const,
          durable: false,
          reason: `fence row ${targetRowNum} not found or unparseable on ${slug}; fence not rewritten`,
        };
      }

      writeFileSync(tmpPath, edit.body, 'utf-8');
      const tmpBody = readFileSync(tmpPath, 'utf-8');
      const postWarnings = parseFactsFence(tmpBody).warnings;
      if (introducesNewWarnings(preWarnings, postWarnings)) {
        // Quarantine the .tmp; leave the canonical file alone.
        const applied = await stampDb();
        return {
          applied,
          path: 'db_fallback' as const,
          durable: false,
          reason: 'fence edit would introduce parse warnings; .tmp quarantined, fence not rewritten',
        };
      }
      renameSync(tmpPath, filePath);

      // Fence committed — stamp the DB to match so active-fact queries
      // are accurate immediately, without waiting for the next
      // reconcile. The fence is now the durable record either way.
      await stampDb();
      return { applied: true, path: 'fence' as const, durable: true };
    } catch (err) {
      // Never worse than the pre-fix behavior: on any unexpected fence
      // failure, stamp the DB and disclose non-durability.
      const applied = await stampDb();
      return {
        applied,
        path: 'db_fallback' as const,
        durable: false,
        reason: `fence rewrite failed (${err instanceof Error ? err.message : String(err)}); DB stamped only`,
      };
    }
  }, { timeoutMs: 5_000 });
}
