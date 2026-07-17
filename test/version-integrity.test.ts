/**
 * Version-history integrity — VT-1..VT-7, VT-9 (engine audit 2026-07-17).
 *
 * The worker's time-travel honesty (open_note_as_of) rests on one contract:
 * a version row at T = the content that stood until T (construct.ts:511-513).
 * The audit found that contract enforced only by caller discipline at two
 * call sites, and annihilated wholesale by the primary ingest path:
 *
 *   VT-1 (P0)  sync-driven repo deletes are HARD deletes; page_versions is
 *              ON DELETE CASCADE → the page's entire past silently destroyed.
 *   VT-2 (P1)  re-import over a soft-deleted page clobbers content with no
 *              snapshot and leaves the row deleted (fabricated history).
 *   VT-3 (P1)  refreshPageBody rewrites compiled_truth with no snapshot
 *              (un-fixed sibling of the 4a33b46 materialize poison fix).
 *   VT-4 (P1)  revert leaves content_hash pointing at the future → next sync
 *              hash-match silently re-clobbers the revert, unversioned.
 *   VT-5 (P1)  soft-delete/restore leave no durable record of the deletion
 *              interval — as-of reads inside it are unfalsifiably wrong.
 *   VT-6 (P1)  direct putPage callers overwrite pages unversioned — the
 *              engine.ts:1982 claim ("createVersion fires on every putPage
 *              with an existing row") was a lie enforced nowhere.
 *   VT-7 (P2)  revertToVersion is fire-and-forget: a foreign/bogus version id
 *              matches 0 rows, returns cleanly, and the op reports 'reverted'
 *              while pre-minting a spurious snapshot.
 *   VT-9 (P2)  withImportTransaction is source-blind.
 *
 * These tests were written RED-FIRST against the unchanged parent
 * (origin/fix/engine-recall-quality @ 5190c7f) and pin the fix:
 * versioning becomes an ENGINE property (putPage / refreshPageBody /
 * revertToVersion snapshot in the same SQL statement as the rewrite), sync
 * deletes become soft deletes, and every remaining loss point (purge TTL)
 * is explicit in ingest_log rather than silent.
 *
 * Runs entirely on PGLite (keyless, in-memory).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, withImportTransaction } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['vi-src-a', 'vi-src-b']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const notePage = (body: string, title = 'VI note') => ({
  type: 'note' as string,
  title,
  compiled_truth: body,
  timeline: '',
  frontmatter: {} as Record<string, unknown>,
});

async function versionBodies(slug: string, sourceId = 'default'): Promise<string[]> {
  const vs = await engine.getVersions(slug, { sourceId });
  return vs.map(v => v.compiled_truth);
}

async function lifecycleLog(slugRef: string): Promise<Array<{ summary: string; source_ref: string }>> {
  return engine.executeRaw<{ summary: string; source_ref: string }>(
    `SELECT summary, source_ref FROM ingest_log
      WHERE source_type = 'page_lifecycle' AND source_ref = $1
      ORDER BY id`,
    [slugRef],
  );
}

// ---------------------------------------------------------------------------
// VT-6 — versioning is an ENGINE property of putPage, not caller discipline
// ---------------------------------------------------------------------------
describe('VT-6: putPage banks the pre-update state itself', () => {
  test('direct putPage overwrite snapshots the content that stood until now', async () => {
    const slug = 'vi/putpage-banks';
    await engine.putPage(slug, notePage('cycle-N text'));
    expect(await versionBodies(slug)).toEqual([]); // creation: nothing stood before

    await engine.putPage(slug, notePage('cycle-N+1 text'));
    const bodies = await versionBodies(slug);
    // Pre-fix RED: [] — the cycle-N text is gone from history forever and
    // as-of reads serve cycle-N+1 text as historical truth (VT-6 repro:
    // synthesize-concepts / synthesize / think / extract-atoms all write
    // through this exact path).
    expect(bodies).toEqual(['cycle-N text']);
  });

  test('no-op rewrite mints no version row (chain stays 1:1 with real changes)', async () => {
    const slug = 'vi/putpage-noop';
    await engine.putPage(slug, notePage('same text'));
    await engine.putPage(slug, notePage('same text'));
    await engine.putPage(slug, notePage('same text'));
    expect(await versionBodies(slug)).toEqual([]);
  });

  test('frontmatter-only change banks the old frontmatter', async () => {
    const slug = 'vi/putpage-fm';
    await engine.putPage(slug, { ...notePage('body'), frontmatter: { stage: 'old' } });
    await engine.putPage(slug, { ...notePage('body'), frontmatter: { stage: 'new' } });
    const vs = await engine.getVersions(slug, { sourceId: 'default' });
    expect(vs.length).toBe(1);
    expect((vs[0].frontmatter as Record<string, unknown>).stage).toBe('old');
  });

  test('title-only change mints no row (snapshots cannot capture title)', async () => {
    const slug = 'vi/putpage-title';
    await engine.putPage(slug, notePage('body', 'Title A'));
    await engine.putPage(slug, notePage('body', 'Title B'));
    expect(await versionBodies(slug)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// VT-3 — refreshPageBody (phantom-redirect rewrite path)
// ---------------------------------------------------------------------------
describe('VT-3: refreshPageBody snapshots before the rewrite', () => {
  test('the pre-rewrite body is banked; as-of at T can still serve X', async () => {
    const slug = 'vi/refresh-banks';
    await engine.putPage(slug, notePage('X — before the redirect'));
    await engine.refreshPageBody(slug, 'default', 'X-prime — after fact migration', '', 'hash-xp');
    const bodies = await versionBodies(slug);
    // Pre-fix RED: [] — identical mechanism to the materialize poison the
    // team fixed one commit earlier (4a33b46); the sweep stopped one caller
    // short.
    expect(bodies).toEqual(['X — before the redirect']);

    // Idempotent re-call (the documented contract): no snapshot spam.
    await engine.refreshPageBody(slug, 'default', 'X-prime — after fact migration', '', 'hash-xp');
    expect((await versionBodies(slug)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VT-7 + VT-4 — revert honesty (engine + op layer)
// ---------------------------------------------------------------------------
describe('VT-7/VT-4: revertToVersion validates, snapshots, and marks the hash', () => {
  test('revert banks the pre-revert head at the ENGINE level and restores content', async () => {
    const slug = 'vi/revert-banks';
    await engine.putPage(slug, notePage('version A'));
    await engine.putPage(slug, notePage('version B')); // banks A
    const vs = await engine.getVersions(slug, { sourceId: 'default' });
    expect(vs.length).toBe(1);

    await engine.revertToVersion(slug, vs[0].id, { sourceId: 'default' });
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toBe('version A');
    // Pre-fix RED: the pre-revert head (B) was destroyed with no snapshot —
    // append-only lived in the op layer, not the engine.
    expect(await versionBodies(slug)).toContain('version B');
  });

  test('revert stamps content_hash so the next sync cannot silently re-clobber it', async () => {
    const slug = 'vi/revert-hash';
    await engine.putPage(slug, { ...notePage('disk state A'), content_hash: 'sha-a' });
    await engine.putPage(slug, { ...notePage('disk state B'), content_hash: 'sha-b' });
    const vs = await engine.getVersions(slug, { sourceId: 'default' });
    const target = vs.find(v => v.compiled_truth === 'disk state A')!;
    await engine.revertToVersion(slug, target.id, { sourceId: 'default' });

    const page = await engine.getPage(slug, { sourceId: 'default' });
    // Pre-fix RED: content_hash still 'sha-b' → sync's hash-match skip treats
    // the reverted DB as already matching a disk file containing B, silently
    // re-clobbering the revert (VT-4). Post-fix the hash is a revert marker
    // that can never equal a computed content hash, forcing an honest,
    // versioned re-reconcile on the next sync.
    expect(page!.content_hash).not.toBe('sha-b');
    expect((page!.content_hash ?? '').startsWith('reverted:')).toBe(true);
  });

  test('a version id belonging to ANOTHER page throws instead of no-op "success"', async () => {
    await engine.putPage('vi/revert-mine', notePage('mine v1'));
    await engine.putPage('vi/revert-mine', notePage('mine v2'));
    await engine.putPage('vi/revert-other', notePage('other v1'));
    await engine.putPage('vi/revert-other', notePage('other v2'));
    const otherVs = await engine.getVersions('vi/revert-other', { sourceId: 'default' });

    // Pre-fix RED: matches 0 rows, returns cleanly — the customer proceeds on
    // a false belief (VT-7a).
    await expect(
      engine.revertToVersion('vi/revert-mine', otherVs[0].id, { sourceId: 'default' }),
    ).rejects.toThrow(/not found/i);
    // And the failed attempt must not have moved anything.
    const page = await engine.getPage('vi/revert-mine', { sourceId: 'default' });
    expect(page!.compiled_truth).toBe('mine v2');
  });

  test('a bogus version id throws', async () => {
    await engine.putPage('vi/revert-bogus', notePage('only'));
    await expect(
      engine.revertToVersion('vi/revert-bogus', 99_999_999, { sourceId: 'default' }),
    ).rejects.toThrow(/not found/i);
  });

  test('revert_version OP: foreign id → error, and NO spurious snapshot is minted', async () => {
    const slugA = 'vi/op-revert-a';
    const slugB = 'vi/op-revert-b';
    await engine.putPage(slugA, notePage('a1'));
    await engine.putPage(slugA, notePage('a2'));
    await engine.putPage(slugB, notePage('b1'));
    await engine.putPage(slugB, notePage('b2'));
    const bVersions = await engine.getVersions(slugB, { sourceId: 'default' });
    const aCountBefore = (await engine.getVersions(slugA, { sourceId: 'default' })).length;

    const ctx = { engine, dryRun: false } as unknown as OperationContext;
    // Pre-fix RED: returns { status: 'reverted' } unconditionally AND the
    // pre-flight createVersion minted a spurious duplicate snapshot for a
    // revert that never happened (VT-7 receipt: operations.ts:2583-2586).
    await expect(
      operationsByName['revert_version'].handler(ctx, { slug: slugA, version_id: bVersions[0].id }),
    ).rejects.toThrow();
    const aCountAfter = (await engine.getVersions(slugA, { sourceId: 'default' })).length;
    expect(aCountAfter).toBe(aCountBefore);
  });

  test('revert_version OP: valid revert succeeds and discloses what was NOT restored', async () => {
    const slug = 'vi/op-revert-ok';
    await engine.putPage(slug, notePage('op v1'));
    await engine.putPage(slug, notePage('op v2'));
    const vs = await engine.getVersions(slug, { sourceId: 'default' });
    const ctx = { engine, dryRun: false } as unknown as OperationContext;
    const res = await operationsByName['revert_version'].handler(ctx, {
      slug,
      version_id: vs[0].id,
    }) as Record<string, unknown>;
    expect(res.status).toBe('reverted');
    // Honesty disclosure: snapshots capture only (compiled_truth, frontmatter);
    // title/type/timeline and the search index are NOT restored by a revert.
    expect(Array.isArray(res.not_restored)).toBe(true);
    expect(res.not_restored as string[]).toContain('search_index');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toBe('op v1');
  });
});

// ---------------------------------------------------------------------------
// VT-2 — re-import over a soft-deleted page
// ---------------------------------------------------------------------------
describe('VT-2: import over a soft-deleted page snapshots + resurrects', () => {
  test('content A is banked and the page comes back live with content B', async () => {
    const slug = 'vi/reimport-tombstone';
    await importFromContent(engine, slug, '# T\n\ncontent A — the recoverable state', { noEmbed: true });
    await engine.softDeletePage(slug, { sourceId: 'default' });

    await importFromContent(engine, slug, '# T\n\ncontent B — imported over the tombstone', { noEmbed: true });

    const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
    expect(page).not.toBeNull();
    // Pre-fix RED (both): the upsert hit the soft-deleted row but never
    // cleared deleted_at (import "succeeded" into an invisible page), and
    // content A was overwritten with NO version row — unrecoverable loss
    // inside the grace window that exists precisely to prevent it.
    expect(page!.deleted_at).toBeNull();
    expect(await versionBodies(slug)).toContain('# T\n\ncontent A — the recoverable state');
    expect(page!.compiled_truth).toContain('content B');
  });
});

// ---------------------------------------------------------------------------
// VT-5 — the deletion interval is recorded, not erased
// ---------------------------------------------------------------------------
describe('VT-5: soft-delete + restore leave a durable lifecycle record', () => {
  test('softDeletePage writes a page_lifecycle ingest_log row', async () => {
    const slug = 'vi/lifecycle-delete';
    await engine.putPage(slug, notePage('body'));
    await engine.softDeletePage(slug, { sourceId: 'default' });
    const log = await lifecycleLog(slug);
    // Pre-fix RED: nothing anywhere records that this page was ever deleted.
    expect(log.length).toBe(1);
    expect(log[0].summary).toContain('soft-deleted');
  });

  test('restorePage records the deletion interval before erasing deleted_at', async () => {
    const slug = 'vi/lifecycle-restore';
    await engine.putPage(slug, notePage('body'));
    await engine.softDeletePage(slug, { sourceId: 'default' });
    const before = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
    const deletedAtIso = new Date(before!.deleted_at as unknown as string).toISOString().slice(0, 10);

    await engine.restorePage(slug, { sourceId: 'default' });
    const log = await lifecycleLog(slug);
    // Pre-fix RED: deleted_at is nulled in place — the data needed to catch a
    // wrong as-of answer inside [deleted, restored] no longer exists anywhere.
    const restoreRow = log.find(r => r.summary.includes('restored'));
    expect(restoreRow).toBeDefined();
    // The interval start (the old deleted_at) is recorded in the summary.
    expect(restoreRow!.summary).toContain(deletedAtIso);
  });
});

// ---------------------------------------------------------------------------
// VT-1 — the P0: sync hard-delete annihilates history; purge must disclose
// ---------------------------------------------------------------------------
describe('VT-1: repo-driven deletes preserve history; purge loss is explicit', () => {
  test('softDeletePages batch primitive flips only active rows in the source', async () => {
    await engine.putPage('vi/batch-1', notePage('b1'), { sourceId: 'vi-src-a' });
    await engine.putPage('vi/batch-2', notePage('b2'), { sourceId: 'vi-src-a' });
    await engine.putPage('vi/batch-1', notePage('other source'), { sourceId: 'vi-src-b' });
    await engine.softDeletePage('vi/batch-2', { sourceId: 'vi-src-a' }); // already gone

    // Pre-fix RED: engine.softDeletePages does not exist.
    const flipped = await engine.softDeletePages(['vi/batch-1', 'vi/batch-2', 'vi/ghost'], {
      sourceId: 'vi-src-a',
    });
    expect(flipped).toEqual(['vi/batch-1']);
    const otherSource = await engine.getPage('vi/batch-1', { sourceId: 'vi-src-b' });
    expect(otherSource).not.toBeNull(); // multi-source isolation
  });

  test('purgeDeletedPages counts + logs the version rows it destroys', async () => {
    const slug = 'vi/purge-discloses';
    await engine.putPage(slug, notePage('v1'));
    await engine.putPage(slug, notePage('v2')); // banks v1
    await engine.softDeletePage(slug, { sourceId: 'default' });
    // Backdate the tombstone: purge uses strict `deleted_at < now() - TTL`
    // and PGLite can land both statements in the same microsecond.
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = deleted_at - interval '1 hour' WHERE slug = $1`,
      [slug],
    );

    const result = await engine.purgeDeletedPages(0);
    expect(result.slugs).toContain(slug);
    // Pre-fix RED: the purge comment enumerates cascade targets and does not
    // even mention page_versions — the history destruction was unconsidered
    // and undisclosed.
    expect(result.versionRowsDestroyed).toBeGreaterThanOrEqual(1);
    const purgeLog = await engine.executeRaw<{ summary: string }>(
      `SELECT summary FROM ingest_log
        WHERE source_type = 'page_lifecycle' AND source_ref = 'purge'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(purgeLog.length).toBe(1);
    expect(purgeLog[0].summary).toMatch(/version row/);
  });

  test('P0 repro: file removed from the synced repo → history SURVIVES the sync', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-vt1-'));
    const git = (cmd: string) => execSync(cmd, { cwd: repoPath, stdio: 'pipe' });
    try {
      git('git init');
      git('git config user.email "t@t.com"');
      git('git config user.name "T"');
      mkdirSync(join(repoPath, 'notes'), { recursive: true });
      const file = join(repoPath, 'notes/keeper.md');
      writeFileSync(file, ['---', 'type: note', 'title: Keeper', '---', '', 'the original truth'].join('\n'));
      git('git add -A && git commit -m "initial"');

      const { performSync } = await import('../src/commands/sync.ts');
      await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

      // Edit → sync mints a version row (the content that stood until T).
      writeFileSync(file, ['---', 'type: note', 'title: Keeper', '---', '', 'the revised truth'].join('\n'));
      git('git add -A && git commit -m "revise"');
      await performSync(engine, { repoPath, noPull: true, noEmbed: true });
      expect(await versionBodies('notes/keeper')).toContain('the original truth');

      // The customer removes the file. Pre-fix this is a HARD delete and
      // page_versions is ON DELETE CASCADE: every as-of question at any T
      // while the page existed now answers "this page never existed".
      unlinkSync(file);
      git('git add -A && git commit -m "remove keeper"');
      await performSync(engine, { repoPath, noPull: true, noEmbed: true });

      const tombstone = await engine.getPage('notes/keeper', { includeDeleted: true });
      // Pre-fix RED: null — row and history cascade-annihilated by the
      // PRIMARY ingest path with zero version machinery engaged.
      expect(tombstone).not.toBeNull();
      expect(tombstone!.deleted_at).not.toBeNull();
      // Hidden everywhere the user looks (v0.26.5 posture preserved) …
      expect(await engine.getPage('notes/keeper')).toBeNull();
      // … but the past is still provable until the disclosed purge TTL.
      const bodies = await versionBodies('notes/keeper');
      expect(bodies).toContain('the original truth');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// VT-9 — withImportTransaction source threading
// ---------------------------------------------------------------------------
describe('VT-9: withImportTransaction threads sourceId', () => {
  test('the page lands in the caller\'s source, not default', async () => {
    const slug = 'vi/tx-scoped';
    await withImportTransaction(engine, {
      slug,
      sourceId: 'vi-src-a',
      hadExisting: false,
      page: notePage('scoped body'),
    });
    // Pre-fix RED: neither putPage nor the existing-row snapshot carried a
    // sourceId — the page lands under 'default' (or snapshots the WRONG
    // source's row when the slug exists in both).
    const scoped = await engine.getPage(slug, { sourceId: 'vi-src-a' });
    expect(scoped).not.toBeNull();
    const defaulted = await engine.getPage(slug, { sourceId: 'default' });
    expect(defaulted).toBeNull();
  });
});
