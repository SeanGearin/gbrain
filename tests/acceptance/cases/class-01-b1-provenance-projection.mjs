// Class 1 — B1: recall fact rows carry the provenance key (commit 04882e1f).
//
// The engine has stored per-fact provenance since migration v114; B1 threads
// it through the recall projection so a tenant can see which memories the
// user stated, which the model inferred, and which predate the stamp. The
// contract locked here, black-box through dispatchToolCall on the customer
// plane:
//   - every recall fact object carries a `provenance` key,
//   - values project as 'user_stated' / 'model_inferred' / null-for-legacy,
//   - the customer plane STILL omits source_session (the strip is untouched),
//   - the key rides every recall surface (filterless, grep, every page of a
//     paginated walk) — including empty pages, which keep their shape,
//   - ordering and total are untouched: a stamp (or its absence) never moves
//     a row and never drops one, on the entity path and the filterless
//     control alike,
//   - the stored value narrows to the enum on read: an out-of-enum value on
//     the unconstrained TEXT column projects null and never leaks.

import { makeEngine, customerCaller, dispatch, canonTimestamps } from '../_harness.mjs';

export const meta = { class: 1, title: 'B1 — provenance projection on recall', requires: 'b1_provenance' };

const SOURCE = 'accept-b1';

// The exact customer-plane fact-object key sequence after B1: the pre-B1
// projection with `provenance` added before created_at and source_session
// stripped. "Nothing removed, renamed, or reordered" is part of the feature
// contract, so the sequence — not just the set — is asserted.
const CUSTOMER_FACT_KEYS = [
  'id', 'fact', 'kind', 'entity_slug', 'visibility', 'notability',
  'valid_from', 'valid_until', 'expired_at', 'superseded_by',
  'consolidated_at', 'consolidated_into', 'source', 'confidence',
  'provenance', 'created_at',
].join(',');

const PROVENANCE_ENUM = new Set(['user_stated', 'model_inferred', null]);

/** Shared per-payload floor: key on every fact, enum honest, strip intact. */
function assertFactSurface(t, label, payload) {
  const facts = payload?.facts ?? [];
  t.must(Array.isArray(payload?.facts), `${label}: payload.facts is an array`);
  t.must(facts.every((f) => 'provenance' in f), `${label}: every fact object carries the provenance key`);
  t.no(facts.some((f) => !PROVENANCE_ENUM.has(f.provenance)), `${label}: a provenance value outside the enum (user_stated | model_inferred | null)`);
  t.no(facts.some((f) => 'source_session' in f), `${label}: source_session on the customer plane (the strip must survive B1)`);
}

const idsOf = (payload) => (payload?.facts ?? []).map((f) => f.id);
const descending = (ids) => ids.every((id, i) => i === 0 || ids[i - 1] > id);

export const cases = [
  {
    id: '1.1',
    title: 'user_stated / model_inferred / legacy-null all project; source_session stays stripped',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);

        // Two client-authored memories through the public save_facts surface —
        // one the user stated outright, one the client model inferred.
        const save = await dispatch(engine, 'save_facts', {
          claims: [
            { claim: 'Priya is allergic to penicillin', provenance: 'user_stated', people: ['Priya'], kind: 'fact' },
            { claim: 'Priya probably prefers morning meetings', provenance: 'model_inferred', people: ['Priya'] },
          ],
        }, caller);

        // A legacy row: server-extracted (or pre-v114) — no provenance stamp,
        // and a source_session the customer plane must never surface. Seeded
        // at the engine seam because no public op writes an unstamped row;
        // the read under test stays black-box through dispatch.
        await engine.insertFact(
          {
            fact: 'Priya joined the hiking club',
            kind: 'fact',
            entity_slug: 'people/priya',
            source: 'mcp:extract_facts',
            source_session: 'sess-legacy-0042',
            visibility: 'world',
            embedding: null,
          },
          { source_id: SOURCE },
        );

        const recall = await dispatch(engine, 'recall', { entity: 'people/priya' }, caller);

        return canonTimestamps({
          save: { isError: save.isError, payload: save.payload },
          recall: { isError: recall.isError, payload: recall.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const facts = cap.recall?.payload?.facts ?? [];
      t.must(cap.save.isError === false && cap.recall.isError === false, 'both dispatches succeed');
      t.must(cap.recall.payload?.total === 3, 'all three rows recall (owner carve-out + world legacy row)');
      t.must(facts.every((f) => 'provenance' in f), 'every recall fact row carries the provenance key');
      t.no(
        facts.some((f) => f.provenance !== null && f.provenance !== 'user_stated' && f.provenance !== 'model_inferred'),
        'a provenance value outside the enum (user_stated | model_inferred | null)',
      );
      t.no(facts.some((f) => 'source_session' in f), 'source_session on the customer plane (the strip must survive B1)');

      const byText = Object.fromEntries(facts.map((f) => [f.fact, f]));
      t.must(byText['Priya is allergic to penicillin']?.provenance === 'user_stated', 'the stated claim projects user_stated');
      t.must(byText['Priya probably prefers morning meetings']?.provenance === 'model_inferred', 'the inferred claim projects model_inferred');
      t.must(byText['Priya joined the hiking club']?.provenance === null, 'the legacy row projects null — key present, value honest');
    },
  },

  {
    id: '1.2',
    title: 'the key rides every recall surface: filterless, grep, and each page of a paginated walk',
    async run() {
      const SRC = 'accept-b1-surfaces';
      const { engine, close } = await makeEngine([SRC]);
      try {
        const caller = customerCaller(SRC);

        // Three stamped memories through the public surface (ids 1-3)...
        const saveA = await dispatch(engine, 'save_facts', {
          claims: [
            { claim: 'Ravi trains for the Berlin marathon in October', provenance: 'user_stated', people: ['Ravi'], kind: 'fact' },
            { claim: 'Ravi pulls a double espresso before every long run', provenance: 'user_stated', people: ['Ravi'] },
            { claim: 'Ravi likely tapers his mileage two weeks out', provenance: 'model_inferred', people: ['Ravi'] },
          ],
        }, caller);

        // ...a legacy unstamped row at the seam (id 4, with a source_session
        // the customer plane must keep stripping)...
        await engine.insertFact(
          {
            fact: 'Ravi mapped the old canal route for the club',
            kind: 'fact',
            entity_slug: 'people/ravi',
            source: 'mcp:extract_facts',
            source_session: 'sess-legacy-0117',
            visibility: 'world',
            embedding: null,
          },
          { source_id: SRC },
        );

        // ...and one more stamped save AFTER the legacy row (id 5), so stamped
        // and unstamped rows interleave in the id sequence.
        const saveB = await dispatch(engine, 'save_facts', {
          claims: [
            { claim: 'Ravi probably favors trail routes over road courses', provenance: 'model_inferred', people: ['Ravi'] },
          ],
        }, caller);

        // Every read surface, black-box through dispatch:
        const all = await dispatch(engine, 'recall', {}, caller);
        const grepped = await dispatch(engine, 'recall', { grep: 'route' }, caller);
        const page1 = await dispatch(engine, 'recall', { limit: 2, offset: 0 }, caller);
        const page2 = await dispatch(engine, 'recall', { limit: 2, offset: 2 }, caller);
        const page3 = await dispatch(engine, 'recall', { limit: 2, offset: 4 }, caller);
        const page4 = await dispatch(engine, 'recall', { limit: 2, offset: 6 }, caller); // past the end

        return canonTimestamps({
          save_a: { isError: saveA.isError, payload: saveA.payload },
          save_b: { isError: saveB.isError, payload: saveB.payload },
          all: { isError: all.isError, payload: all.payload },
          grepped: { isError: grepped.isError, payload: grepped.payload },
          pages: [page1, page2, page3, page4].map((p) => ({ isError: p.isError, payload: p.payload })),
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const dispatches = [cap.save_a, cap.save_b, cap.all, cap.grepped, ...cap.pages];
      t.must(dispatches.every((d) => d.isError === false), 'every dispatch succeeds');

      assertFactSurface(t, 'filterless', cap.all.payload);
      assertFactSurface(t, 'grep', cap.grepped.payload);
      cap.pages.forEach((p, i) => assertFactSurface(t, `page ${i + 1}`, p.payload));

      // Filterless recall sees all five rows, newest first (insert order
      // reversed — stable created_at DESC, id DESC).
      t.must(cap.all.payload?.total === 5, 'filterless recall totals all five rows');
      t.must(descending(idsOf(cap.all.payload)), 'filterless recall lists strictly descending ids');

      // Paging by offset walks the full set with no gaps, dupes, or reorders,
      // and each page reports its own row count.
      const walked = cap.pages.flatMap((p) => idsOf(p.payload));
      t.must(JSON.stringify(walked) === JSON.stringify(idsOf(cap.all.payload)), 'the paginated walk reproduces the filterless sequence exactly');
      t.must(JSON.stringify(cap.pages.map((p) => p.payload?.total)) === JSON.stringify([2, 2, 1, 0]), 'page totals report each page\'s own row count');
      t.must(Array.isArray(cap.pages[3].payload?.facts) && cap.pages[3].payload.facts.length === 0, 'the past-the-end page keeps its shape: facts [] and total 0');

      // The client-side grep surface filters rows, never keys: both matches
      // keep their stamps — one model_inferred, one legacy null.
      const grepFacts = cap.grepped.payload?.facts ?? [];
      t.must(cap.grepped.payload?.total === 2, 'grep "route" matches exactly the two route rows');
      t.must(grepFacts.find((f) => f.fact === 'Ravi probably favors trail routes over road courses')?.provenance === 'model_inferred', 'the stamped grep match keeps model_inferred');
      t.must(grepFacts.find((f) => f.fact === 'Ravi mapped the old canal route for the club')?.provenance === null, 'the legacy grep match projects null');
    },
  },

  {
    id: '1.3',
    title: 'ordering and total untouched: interleaved stamped and legacy rows hold insert-reversed order on the entity path and the filterless control alike',
    async run() {
      const SRC = 'accept-b1-control';
      const { engine, close } = await makeEngine([SRC]);
      try {
        const caller = customerCaller(SRC);

        // Legacy and stamped writes strictly interleaved (ids 1-5), so any
        // provenance-sensitive ordering or filtering would visibly scramble
        // or shrink the sequence.
        await engine.insertFact(
          { fact: 'Marisol keeps a sourdough starter named Bruno', kind: 'fact', entity_slug: 'people/marisol', source: 'mcp:extract_facts', source_session: 'sess-legacy-0201', visibility: 'world', embedding: null },
          { source_id: SRC },
        );
        const save1 = await dispatch(engine, 'save_facts', {
          claims: [{ claim: 'Marisol is training to become a licensed arborist', provenance: 'user_stated', people: ['Marisol'], kind: 'fact' }],
        }, caller);
        await engine.insertFact(
          { fact: 'Marisol repairs vintage film cameras on weekends', kind: 'fact', entity_slug: 'people/marisol', source: 'mcp:extract_facts', source_session: 'sess-legacy-0202', visibility: 'world', embedding: null },
          { source_id: SRC },
        );
        const save2 = await dispatch(engine, 'save_facts', {
          claims: [{ claim: 'Marisol presumably prefers autumn hiking trips', provenance: 'model_inferred', people: ['Marisol'] }],
        }, caller);
        await engine.insertFact(
          { fact: 'Marisol chairs the neighborhood garden committee', kind: 'fact', entity_slug: 'people/marisol', source: 'mcp:extract_facts', source_session: 'sess-legacy-0203', visibility: 'world', embedding: null },
          { source_id: SRC },
        );

        // The read under test (entity path) and its control (filterless path)
        // list the same five rows through two different engine queries.
        const entityRecall = await dispatch(engine, 'recall', { entity: 'people/marisol' }, caller);
        const control = await dispatch(engine, 'recall', {}, caller);

        return canonTimestamps({
          save1: { isError: save1.isError, payload: save1.payload },
          save2: { isError: save2.isError, payload: save2.payload },
          entity: { isError: entityRecall.isError, payload: entityRecall.payload },
          control: { isError: control.isError, payload: control.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must([cap.save1, cap.save2, cap.entity, cap.control].every((d) => d.isError === false), 'every dispatch succeeds');
      assertFactSurface(t, 'entity recall', cap.entity.payload);
      assertFactSurface(t, 'control recall', cap.control.payload);

      // Ordering/total untouched vs the control: same rows, same sequence,
      // same count through both list queries — and the sequence is exactly
      // insert order reversed. A stamp never moves a row.
      t.must(JSON.stringify(idsOf(cap.entity.payload)) === JSON.stringify([5, 4, 3, 2, 1]), 'entity recall lists insert order reversed (valid_from DESC, id DESC)');
      t.must(JSON.stringify(idsOf(cap.control.payload)) === JSON.stringify([5, 4, 3, 2, 1]), 'control recall lists the identical sequence');
      t.must(cap.entity.payload?.total === 5 && cap.control.payload?.total === 5, 'both recalls total all five rows');
      t.no(
        (cap.entity.payload?.facts ?? []).some((f) => f.provenance === null) === false,
        'null-provenance rows dropped from recall (legacy rows must always list)',
      );

      // Position-by-position honesty: ids 1/3/5 are the legacy seam rows,
      // 2 the stated claim, 4 the inferred one — on BOTH paths.
      const expectStamps = { 1: null, 2: 'user_stated', 3: null, 4: 'model_inferred', 5: null };
      for (const [label, payload] of [['entity', cap.entity.payload], ['control', cap.control.payload]]) {
        for (const f of payload?.facts ?? []) {
          t.must(f.provenance === expectStamps[f.id], `${label} recall: fact ${f.id} carries its expected stamp (${JSON.stringify(expectStamps[f.id])})`);
        }
      }

      // Additive-only, strip intact: each fact object is EXACTLY the pre-B1
      // customer-plane key sequence plus `provenance` — nothing removed,
      // renamed, or reordered.
      const allFacts = [...(cap.entity.payload?.facts ?? []), ...(cap.control.payload?.facts ?? [])];
      t.must(
        allFacts.every((f) => Object.keys(f).join(',') === CUSTOMER_FACT_KEYS),
        'every fact object carries exactly the customer-plane key sequence (additive provenance, source_session stripped)',
      );
    },
  },

  {
    id: '1.4',
    title: 'the enum-narrowing guard: an out-of-enum stored value projects null on recall and never leaks',
    async run() {
      const SRC = 'accept-b1-guard';
      const { engine, close } = await makeEngine([SRC]);
      try {
        const caller = customerCaller(SRC);

        // The provenance column is unconstrained TEXT (no CHECK — the
        // save_facts handler is the sole writer and validates the enum).
        // Seed a row whose stored value is OUTSIDE the enum, simulating a
        // foreign or pre-guard writer; B1's read-side narrowing must project
        // it as null, never surface the raw string. Seam-seeded — no public
        // op can write this state.
        const seeded = await engine.insertFact(
          {
            fact: 'Tomasz archives shortwave radio broadcasts',
            kind: 'fact',
            entity_slug: 'people/tomasz',
            source: 'mcp:extract_facts',
            source_session: 'sess-legacy-0350',
            visibility: 'world',
            embedding: null,
            provenance: 'extractor_v2', // out-of-enum, inserted verbatim
          },
          { source_id: SRC },
        );

        // De-vacuousing read at the seam: prove the DB really holds the
        // out-of-enum string, so a pass can't come from the seed silently
        // nulling it. The surface under test stays black-box below.
        const rawRows = await engine.executeRaw(
          'SELECT provenance FROM facts WHERE id = $1',
          [seeded.id],
        );

        // A valid stamped row for contrast (id 2).
        const save = await dispatch(engine, 'save_facts', {
          claims: [{ claim: 'Tomasz is renovating a canal barge in Utrecht', provenance: 'user_stated', people: ['Tomasz'], kind: 'fact' }],
        }, caller);

        const recall = await dispatch(engine, 'recall', { entity: 'people/tomasz' }, caller);

        return canonTimestamps({
          seeded_id: seeded.id,
          stored_provenance: rawRows[0]?.provenance ?? null,
          save: { isError: save.isError, payload: save.payload },
          recall: { isError: recall.isError, payload: recall.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must(cap.save.isError === false && cap.recall.isError === false, 'both dispatches succeed');
      t.must(cap.stored_provenance === 'extractor_v2', 'the DB truly stores the out-of-enum value (the guard case is not vacuous)');
      assertFactSurface(t, 'recall', cap.recall.payload);

      const facts = cap.recall.payload?.facts ?? [];
      t.must(cap.recall.payload?.total === 2, 'both rows recall');
      const guarded = facts.find((f) => f.id === cap.seeded_id);
      t.must(guarded?.provenance === null, 'the out-of-enum stored value projects null on read');
      t.no(
        JSON.stringify(cap.recall.payload).includes('extractor_v2'),
        'the raw out-of-enum string anywhere in the recall payload (the narrowing guard must not leak)',
      );
      t.must(facts.find((f) => f.fact === 'Tomasz is renovating a canal barge in Utrecht')?.provenance === 'user_stated', 'the valid stamped row still projects its enum value');
    },
  },
];
