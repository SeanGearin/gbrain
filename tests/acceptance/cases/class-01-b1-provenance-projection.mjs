// Class 1 — B1: recall fact rows carry the provenance key (commit 04882e1f).
//
// The engine has stored per-fact provenance since migration v114; B1 threads
// it through the recall projection so a tenant can see which memories the
// user stated, which the model inferred, and which predate the stamp. The
// contract locked here, black-box through dispatchToolCall on the customer
// plane:
//   - every recall fact object carries a `provenance` key,
//   - values project as 'user_stated' / 'model_inferred' / null-for-legacy,
//   - the customer plane STILL omits source_session (the strip is untouched).

import { makeEngine, customerCaller, dispatch, canonTimestamps } from '../_harness.mjs';

export const meta = { class: 1, title: 'B1 — provenance projection on recall', requires: 'b1_provenance' };

const SOURCE = 'accept-b1';

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
];
