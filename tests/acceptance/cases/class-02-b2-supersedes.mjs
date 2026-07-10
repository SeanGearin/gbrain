// Class 2 — B2: save_facts supersedes (commit 2b8f9265).
//
// A correction on the customer plane reaches the engine's native, atomic
// supersession: insert the replacement + expire the old row (expired_at +
// superseded_by) in one transaction, so no observer ever sees both rows
// active. The contract locked here, black-box through dispatchToolCall:
//   - insert path: correction with `supersedes` writes the new row and
//     expires the target, superseded:1,
//   - dedup path: duplicate+supersedes writes NO new row but still expires
//     the target to the canonical row,
//   - self-supersession is guarded (a row never expires pointing at itself),
//   - a plain save reports superseded:0,
//   - recall with include_expired shows the chain; default recall drops the
//     superseded values.

import { makeEngine, customerCaller, dispatch, canonTimestamps } from '../_harness.mjs';

export const meta = { class: 2, title: 'B2 — save_facts supersedes (atomic correction chain)', requires: 'b2_supersedes' };

const SOURCE = 'accept-b2';

export const cases = [
  {
    id: '2.1',
    title: 'full supersedes lifecycle: insert path, dedup path, self-guard, plain-save zero, recall chain',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // Plain save — the value that will later be corrected. superseded:0.
        const s1 = await save([
          { claim: 'Priya works at Initech', provenance: 'user_stated', people: ['Priya'] },
        ]);
        const initechId = s1.payload?.fact_ids?.[0];

        // INSERT path: lexically distinct correction naming the old row —
        // the supersede link is explicit via the id, never inferred from
        // text overlap. New row in, old row atomically expired.
        const s2 = await save([
          { claim: 'Priya moved to Hooli as of this spring', provenance: 'user_stated', people: ['Priya'], supersedes: initechId },
        ]);
        const hooliId = s2.payload?.fact_ids?.[0];

        // Plain save of a second, unrelated value (the dedup-path target).
        const s3 = await save([
          { claim: 'Priya keeps a standing desk in the office', provenance: 'user_stated', people: ['Priya'] },
        ]);
        const deskId = s3.payload?.fact_ids?.[0];

        // DEDUP path: the correction's text already exists as canonical row
        // hooliId, so no new row is written — the supersede STILL applies:
        // deskId expires pointing at the canonical dup.
        const s4 = await save([
          { claim: 'Priya moved to Hooli as of this spring', provenance: 'user_stated', people: ['Priya'], supersedes: deskId },
        ]);

        // SELF-GUARD: a dup whose supersedes target IS its own matched row —
        // skipped, so a row can never expire and point at itself.
        const s5 = await save([
          { claim: 'Priya moved to Hooli as of this spring', provenance: 'user_stated', people: ['Priya'], supersedes: hooliId },
        ]);

        // Default recall: superseded values are gone. History recall: the
        // full chain is visible (expired_at set, superseded_by linked).
        const recallDefault = await dispatch(engine, 'recall', { entity: 'people/priya' }, caller);
        const recallHistory = await dispatch(engine, 'recall', { entity: 'people/priya', include_expired: true }, caller);

        return canonTimestamps({
          ids: { initechId, hooliId, deskId },
          plain_save: { isError: s1.isError, payload: s1.payload },
          insert_path_correction: { isError: s2.isError, payload: s2.payload },
          second_plain_save: { isError: s3.isError, payload: s3.payload },
          dedup_path_correction: { isError: s4.isError, payload: s4.payload },
          self_supersession_attempt: { isError: s5.isError, payload: s5.payload },
          recall_default: { isError: recallDefault.isError, payload: recallDefault.payload },
          recall_history: { isError: recallHistory.isError, payload: recallHistory.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { initechId, hooliId, deskId } = cap.ids;
      t.must(
        [cap.plain_save, cap.insert_path_correction, cap.second_plain_save, cap.dedup_path_correction, cap.self_supersession_attempt, cap.recall_default, cap.recall_history]
          .every((s) => s.isError === false),
        'every dispatch succeeds',
      );

      // Plain saves NEVER report a supersession.
      t.no(cap.plain_save.payload.superseded !== 0, 'a plain save reporting superseded != 0');
      t.no(cap.second_plain_save.payload.superseded !== 0, 'a plain save reporting superseded != 0 (second)');

      // Insert path: new row + one supersession dispatched.
      t.must(cap.insert_path_correction.payload.inserted === 1, 'insert-path correction writes the new row');
      t.must(cap.insert_path_correction.payload.superseded === 1, 'insert-path correction counts one supersession');
      t.no(hooliId === initechId, 'the correction reusing the superseded row id');

      // Dedup path: no new row, canonical id returned, supersede applied.
      t.must(cap.dedup_path_correction.payload.inserted === 0, 'dedup-path correction writes NO new row');
      t.must(cap.dedup_path_correction.payload.duplicate === 1, 'dedup-path correction reports the duplicate');
      t.must(cap.dedup_path_correction.payload.superseded === 1, 'dedup-path correction still applies the supersede');
      t.must(cap.dedup_path_correction.payload.fact_ids?.[0] === hooliId, 'dedup-path correction returns the canonical row id');

      // Self-supersession NEVER lands.
      t.no(cap.self_supersession_attempt.payload.superseded !== 0, 'a self-supersession counting as applied');

      const histById = Object.fromEntries((cap.recall_history.payload.facts ?? []).map((f) => [f.id, f]));
      const defaultIds = (cap.recall_default.payload.facts ?? []).map((f) => f.id);

      // The chain, as recall projects it.
      t.must(histById[initechId]?.expired_at !== null && histById[initechId]?.expired_at !== undefined, 'superseded row carries expired_at');
      t.must(histById[initechId]?.superseded_by === hooliId, 'superseded row points at its replacement');
      t.must(histById[deskId]?.expired_at !== null && histById[deskId]?.expired_at !== undefined, 'dedup-path target carries expired_at');
      t.must(histById[deskId]?.superseded_by === hooliId, 'dedup-path target points at the canonical row');
      t.must(histById[hooliId]?.expired_at === null && histById[hooliId]?.superseded_by === null, 'the canonical row stays active and unlinked');
      t.no(Object.values(histById).some((f) => f.superseded_by === f.id), 'a row superseded by itself');

      // Default recall NEVER shows a superseded value alongside its
      // replacement — no observer sees both rows active.
      t.must(defaultIds.includes(hooliId), 'default recall returns the replacement');
      t.no(defaultIds.includes(initechId), 'default recall returning the superseded value');
      t.no(defaultIds.includes(deskId), 'default recall returning the dedup-path expired value');
    },
  },
];
