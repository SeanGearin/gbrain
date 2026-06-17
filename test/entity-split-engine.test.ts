/**
 * Entity split correction.
 *
 * A mis-merged entity is represented by ordinary source-scoped rows pointing
 * at one slug. The correction path must preserve row identity while moving
 * only the operator-selected fact/edge/history rows to the restored slug.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { NewFact } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string };

const fact = (rowNum: number, text: string, overrides: Partial<BatchFact> = {}): BatchFact => ({
  fact: text,
  kind: 'fact',
  entity_slug: 'people/alice-example',
  visibility: 'world',
  notability: 'medium',
  source: 'test:entity-split',
  source_session: 'entity-split-test',
  confidence: 1.0,
  row_num: rowNum,
  source_markdown_slug: 'people/alice-example',
  ...overrides,
});

async function putPerson(slug: string, title: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, {
    type: 'person',
    title,
    compiled_truth: `# ${title}\n`,
    timeline: '',
    frontmatter: {},
  }, { sourceId });
}

describe('engine.splitEntity', () => {
  test('partitions selected facts, edges, timeline rows, and aliases without losing history', async () => {
    const fromSlug = 'people/alice-example';
    const toSlug = 'people/bob-example';
    const noteSlug = 'notes/source-note';

    await putPerson(fromSlug, 'Alice Example');
    await putPerson(toSlug, 'Bob Example');
    await engine.putPage(noteSlug, {
      type: 'note',
      title: 'Source Note',
      compiled_truth: '# Source Note\n',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'default' });
    await engine.createVersion(fromSlug, { sourceId: 'default' });

    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('other-source', 'other-source', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await putPerson(fromSlug, 'Alice Other Source', 'other-source');
    await putPerson(toSlug, 'Bob Other Source', 'other-source');

    const inserted = await engine.insertFacts(
      [
        fact(1, 'Alice owns the alpha fact'),
        fact(2, 'Bob owns the beta fact'),
      ],
      { source_id: 'default' },
    );
    const otherInserted = await engine.insertFacts(
      [
        fact(1, 'Other source fact stays merged', {
          entity_slug: fromSlug,
          source_markdown_slug: fromSlug,
        }),
      ],
      { source_id: 'other-source' },
    );

    await engine.addLinksBatch([
      {
        from_slug: fromSlug,
        to_slug: noteSlug,
        link_type: 'knows',
        context: 'merged outgoing',
        link_source: 'manual',
        from_source_id: 'default',
        to_source_id: 'default',
      },
      {
        from_slug: noteSlug,
        to_slug: fromSlug,
        link_type: 'mentions',
        context: 'merged incoming',
        link_source: 'manual',
        from_source_id: 'default',
        to_source_id: 'default',
      },
    ]);

    await engine.addTimelineEntry(fromSlug, {
      date: '2026-01-02',
      source: 'test',
      summary: 'Bob event',
      detail: 'belongs to the restored entity',
    }, { sourceId: 'default' });
    const timelineId = Number((await engine.getTimeline(fromSlug, { sourceId: 'default' }))[0].id);

    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'bob alias', $1)`,
      [fromSlug],
    );
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
       VALUES ('default', $1, $2)`,
      [toSlug, fromSlug],
    );

    const result = await engine.splitEntity({
      source_id: 'default',
      from_slug: fromSlug,
      to_slug: toSlug,
      fact_ids: [inserted.ids[1]],
      link_moves: [
        { direction: 'outgoing', other_slug: noteSlug, link_type: 'knows', link_source: 'manual' },
        { direction: 'incoming', other_slug: noteSlug, link_type: 'mentions', link_source: 'manual' },
      ],
      timeline_ids: [timelineId],
      page_aliases_to_move: ['bob alias'],
      slug_aliases_to_remove: [toSlug],
      reason: 'test correction',
    });

    expect(result).toMatchObject({
      source_id: 'default',
      from_slug: fromSlug,
      to_slug: toSlug,
      fact_ids_moved: [inserted.ids[1]],
      links_moved: 2,
      links_deduped: 0,
      timeline_ids_moved: [timelineId],
      page_aliases_moved: 1,
      page_aliases_deduped: 0,
      slug_aliases_removed: [toSlug],
    });

    const factRows = await engine.executeRaw<{
      id: number;
      entity_slug: string;
      source_markdown_slug: string | null;
      context: string | null;
      source_session: string | null;
    }>(
      `SELECT id, entity_slug, source_markdown_slug, context, source_session
       FROM facts
       WHERE source_id = 'default'
       ORDER BY id`,
    );
    expect(factRows).toEqual([
      {
        id: inserted.ids[0],
        entity_slug: fromSlug,
        source_markdown_slug: fromSlug,
        context: null,
        source_session: 'entity-split-test',
      },
      {
        id: inserted.ids[1],
        entity_slug: toSlug,
        source_markdown_slug: null,
        context: `entity_split: moved from ${fromSlug} to ${toSlug}; reason: test correction`,
        source_session: 'entity-split-test',
      },
    ]);

    const otherSourceFacts = await engine.executeRaw<{ id: number; entity_slug: string }>(
      `SELECT id, entity_slug
       FROM facts
       WHERE source_id = 'other-source'`,
    );
    expect(otherSourceFacts).toEqual([{ id: otherInserted.ids[0], entity_slug: fromSlug }]);

    expect((await engine.getLinks(fromSlug, { sourceId: 'default' })).map((l) => l.to_slug)).not.toContain(noteSlug);
    expect((await engine.getLinks(toSlug, { sourceId: 'default' })).map((l) => [l.to_slug, l.link_type])).toContainEqual([noteSlug, 'knows']);
    expect((await engine.getBacklinks(toSlug, { sourceId: 'default' })).map((l) => [l.from_slug, l.link_type])).toContainEqual([noteSlug, 'mentions']);

    expect((await engine.getTimeline(fromSlug, { sourceId: 'default' })).map((row) => row.summary)).not.toContain('Bob event');
    expect((await engine.getTimeline(toSlug, { sourceId: 'default' })).map((row) => row.summary)).toContain('Bob event');

    const aliasRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM page_aliases WHERE source_id = 'default' AND alias_norm = 'bob alias'`,
    );
    expect(aliasRows).toEqual([{ slug: toSlug }]);
    expect(await engine.resolveSlugWithAlias(toSlug, 'default')).toBe(toSlug);

    const versions = await engine.getVersions(fromSlug, { sourceId: 'default' });
    expect(versions).toHaveLength(1);
    expect(versions[0].compiled_truth).toBe('# Alice Example\n');
  });
});
