// Class 2 — B2: save_facts supersedes (commit 2b8f9265).
//
// A correction on the customer plane reaches the engine's native, atomic
// supersession: insert the replacement + expire the old row (expired_at +
// superseded_by) in one transaction, so no observer ever sees both rows
// active. The contract locked here, black-box through dispatchToolCall:
//   2.1  full lifecycle exemplar (insert path, dedup path, self-guard,
//        plain-save zero, recall chain — one end-to-end run)
//   2.2  insert path: the atomic chain, with bystander rows untouched
//   2.3  dedup path: duplicate+supersedes writes NO new row but still
//        expires the target to the canonical row
//   2.4  self-supersession is guarded — a row never expires pointing at itself
//   2.5  a plain save always reports superseded:0 (dup or not)
//   2.6  recall {supersessions:true} shows the full correction chain
//   2.7  default recall drops the superseded value; history keeps it
//   2.8  an invalid target (unknown / already-expired) leaves the old row
//        intact — the chain is never rewritten
//   2.9  a malformed `supersedes` rejects the WHOLE batch by index; nothing
//        lands, nothing expires

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

  {
    id: '2.2',
    title: 'insert path: a correction atomically expires its target while bystander rows stay untouched',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // Two plain facts — the first is the one that will be corrected, the
        // second is a bystander that must survive the correction untouched.
        const s1 = await save([
          { claim: 'Marcus rents an apartment in Astoria', provenance: 'user_stated', people: ['Marcus'] },
          { claim: 'Marcus trains for the marathon on weekends', provenance: 'user_stated', people: ['Marcus'] },
        ]);
        const apartmentId = s1.payload?.fact_ids?.[0];
        const marathonId = s1.payload?.fact_ids?.[1];

        // A MIXED batch: one plain claim + one correction. The supersede is
        // threaded per claim — only the claim that carries `supersedes`
        // expires anything.
        const s2 = await save([
          { claim: 'Marcus adopted a beagle named Waffles', provenance: 'user_stated', people: ['Marcus'] },
          { claim: 'Marcus bought a house in Maplewood', provenance: 'user_stated', people: ['Marcus'], supersedes: apartmentId },
        ]);
        const beagleId = s2.payload?.fact_ids?.[0];
        const houseId = s2.payload?.fact_ids?.[1];

        const recallHistory = await dispatch(engine, 'recall', { entity: 'people/marcus', include_expired: true }, caller);

        return canonTimestamps({
          ids: { apartmentId, marathonId, beagleId, houseId },
          seed_saves: { isError: s1.isError, payload: s1.payload },
          mixed_batch: { isError: s2.isError, payload: s2.payload },
          recall_history: { isError: recallHistory.isError, payload: recallHistory.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { apartmentId, marathonId, beagleId, houseId } = cap.ids;
      t.must([cap.seed_saves, cap.mixed_batch, cap.recall_history].every((s) => s.isError === false), 'every dispatch succeeds');

      // Seed batch is plain: superseded 0, two rows in.
      t.must(cap.seed_saves.payload.inserted === 2, 'seed batch inserts both rows');
      t.no(cap.seed_saves.payload.superseded !== 0, 'a plain batch reporting superseded != 0');

      // Mixed batch: the superseding insert IS an insert (new row) — both
      // claims count as inserted, exactly one supersession is applied.
      t.must(cap.mixed_batch.payload.inserted === 2, 'a superseding insert counts as inserted alongside the plain claim');
      t.must(cap.mixed_batch.payload.superseded === 1, 'exactly one supersession applied by the one correcting claim');
      t.must(cap.mixed_batch.payload.duplicate === 0, 'a lexically distinct correction never dedups');
      t.no(houseId === apartmentId, 'the correction reusing the superseded row id');

      const histById = Object.fromEntries((cap.recall_history.payload.facts ?? []).map((f) => [f.id, f]));

      // The chain: the target expired and points at its replacement.
      t.must(histById[apartmentId]?.expired_at !== null && histById[apartmentId]?.expired_at !== undefined, 'the corrected row carries expired_at');
      t.must(histById[apartmentId]?.superseded_by === houseId, 'the corrected row points at its replacement');
      t.must(histById[houseId]?.expired_at === null && histById[houseId]?.superseded_by === null, 'the replacement row is active and unlinked');

      // Bystanders NEVER expire — a correction touches exactly its target.
      t.no(histById[marathonId]?.expired_at !== null, 'a bystander row from the seed batch expiring');
      t.no(histById[beagleId]?.expired_at !== null, 'the plain claim in the mixed batch expiring anything');
      t.no(histById[marathonId]?.superseded_by !== null, 'a bystander row acquiring a supersession link');
      t.no(histById[beagleId]?.superseded_by !== null, 'the plain sibling claim acquiring a supersession link');
    },
  },

  {
    id: '2.3',
    title: 'dedup path: duplicate+supersedes writes NO new row and expires the target to the canonical row',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // The stale value.
        const s1 = await save([
          { claim: 'Nadia is allergic to shellfish', provenance: 'user_stated', people: ['Nadia'] },
        ]);
        const staleId = s1.payload?.fact_ids?.[0];

        // The correction arrives first as a PLAIN save — it becomes the
        // canonical row with no chain recorded yet.
        const s2 = await save([
          { claim: 'Nadia can safely eat shellfish after her treatment', provenance: 'user_stated', people: ['Nadia'] },
        ]);
        const canonicalId = s2.payload?.fact_ids?.[0];

        // The client re-sends the SAME correction text, now with the
        // supersede link. The text dedups to the canonical row — no new row
        // is written — but the supersede still applies: the stale row expires
        // pointing at the canonical dup.
        const s3 = await save([
          { claim: 'Nadia can safely eat shellfish after her treatment', provenance: 'user_stated', people: ['Nadia'], supersedes: staleId },
        ]);

        const recallHistory = await dispatch(engine, 'recall', { entity: 'people/nadia', include_expired: true }, caller);

        return canonTimestamps({
          ids: { staleId, canonicalId },
          stale_save: { isError: s1.isError, payload: s1.payload },
          canonical_save: { isError: s2.isError, payload: s2.payload },
          dedup_correction: { isError: s3.isError, payload: s3.payload },
          recall_history: { isError: recallHistory.isError, payload: recallHistory.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { staleId, canonicalId } = cap.ids;
      t.must([cap.stale_save, cap.canonical_save, cap.dedup_correction, cap.recall_history].every((s) => s.isError === false), 'every dispatch succeeds');

      // The dedup correction NEVER writes a row — canonical id comes back.
      t.must(cap.dedup_correction.payload.inserted === 0, 'dedup-path correction writes NO new row');
      t.must(cap.dedup_correction.payload.duplicate === 1, 'dedup-path correction reports the duplicate');
      t.must(cap.dedup_correction.payload.superseded === 1, 'dedup-path correction still applies the supersede');
      t.must(cap.dedup_correction.payload.fact_ids?.[0] === canonicalId, 'dedup-path correction returns the canonical row id');

      const facts = cap.recall_history.payload.facts ?? [];
      const histById = Object.fromEntries(facts.map((f) => [f.id, f]));

      // Row count NEVER grows on the dedup path: exactly the two rows exist.
      t.no(facts.length !== 2, 'the dedup path growing the row count');
      t.must(histById[staleId]?.expired_at !== null && histById[staleId]?.expired_at !== undefined, 'the stale row carries expired_at');
      t.must(histById[staleId]?.superseded_by === canonicalId, 'the stale row points at the canonical dup');
      t.must(histById[canonicalId]?.expired_at === null && histById[canonicalId]?.superseded_by === null, 'the canonical row stays active and unlinked');
    },
  },

  {
    id: '2.4',
    title: 'self-supersession guarded: a dup whose target is its own matched row is skipped',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        const s1 = await save([
          { claim: 'Omar leads the platform team', provenance: 'user_stated', people: ['Omar'] },
        ]);
        const rowId = s1.payload?.fact_ids?.[0];

        // The same text with supersedes pointing at the row it dedups TO —
        // applying it would expire the canonical row and point superseded_by
        // at itself. The guard skips it: duplicate reported, nothing expires.
        const s2 = await save([
          { claim: 'Omar leads the platform team', provenance: 'user_stated', people: ['Omar'], supersedes: rowId },
        ]);

        const recallDefault = await dispatch(engine, 'recall', { entity: 'people/omar' }, caller);
        const audit = await dispatch(engine, 'recall', { supersessions: true }, caller);

        return canonTimestamps({
          ids: { rowId },
          plain_save: { isError: s1.isError, payload: s1.payload },
          self_supersession_attempt: { isError: s2.isError, payload: s2.payload },
          recall_default: { isError: recallDefault.isError, payload: recallDefault.payload },
          supersession_audit: { isError: audit.isError, payload: audit.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { rowId } = cap.ids;
      t.must([cap.plain_save, cap.self_supersession_attempt, cap.recall_default, cap.supersession_audit].every((s) => s.isError === false), 'every dispatch succeeds');

      // The attempt is a plain duplicate: NEVER counted as a supersession.
      t.must(cap.self_supersession_attempt.payload.duplicate === 1, 'the attempt reports the duplicate');
      t.no(cap.self_supersession_attempt.payload.superseded !== 0, 'a self-supersession counting as applied');

      // The row survives active; the audit log NEVER gains an entry.
      const active = (cap.recall_default.payload.facts ?? []).find((f) => f.id === rowId);
      t.must(active && active.expired_at === null && active.superseded_by === null, 'the target row stays active and unlinked');
      t.no((cap.supersession_audit.payload.facts ?? []).length !== 0, 'the supersession audit gaining a row from a guarded self-supersession');
      t.no((cap.supersession_audit.payload.facts ?? []).some((f) => f.superseded_by === f.id), 'a row superseded by itself');
    },
  },

  {
    id: '2.5',
    title: 'plain saves always report superseded:0 — inserts, dups, and repeat batches alike',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // A mixed plain batch: two distinct claims + an exact dup of the
        // first. No claim carries `supersedes`, so nothing may expire.
        const s1 = await save([
          { claim: 'Lena runs a pottery studio in Asheville', provenance: 'user_stated', people: ['Lena'] },
          { claim: 'Lena volunteers at the animal shelter on Fridays', provenance: 'user_stated', people: ['Lena'] },
          { claim: 'Lena runs a pottery studio in Asheville', provenance: 'user_stated', people: ['Lena'] },
        ]);

        // A follow-up single plain save — the field is always present, 0.
        const s2 = await save([
          { claim: 'Lena is learning to restore vintage kilns', provenance: 'model_inferred', people: ['Lena'] },
        ]);

        const recallHistory = await dispatch(engine, 'recall', { entity: 'people/lena', include_expired: true }, caller);
        const audit = await dispatch(engine, 'recall', { supersessions: true }, caller);

        return canonTimestamps({
          mixed_plain_batch: { isError: s1.isError, payload: s1.payload },
          single_plain_save: { isError: s2.isError, payload: s2.payload },
          recall_history: { isError: recallHistory.isError, payload: recallHistory.payload },
          supersession_audit: { isError: audit.isError, payload: audit.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must([cap.mixed_plain_batch, cap.single_plain_save, cap.recall_history, cap.supersession_audit].every((s) => s.isError === false), 'every dispatch succeeds');

      // superseded is ALWAYS present on the result and ALWAYS 0 on a plain save.
      t.must(cap.mixed_plain_batch.payload.superseded === 0, 'a plain batch (with a dup) reports superseded:0');
      t.must(cap.single_plain_save.payload.superseded === 0, 'a plain single save reports superseded:0');
      t.no(typeof cap.mixed_plain_batch.payload.superseded !== 'number', 'the superseded field missing from a plain-save result');
      t.no(typeof cap.single_plain_save.payload.superseded !== 'number', 'the superseded field missing from a single-save result');
      t.must(cap.mixed_plain_batch.payload.inserted === 2 && cap.mixed_plain_batch.payload.duplicate === 1, 'plain-save insert/dup accounting is unchanged by B2');

      // Plain saves NEVER expire a row, NEVER touch the audit log.
      t.no((cap.recall_history.payload.facts ?? []).some((f) => f.expired_at !== null), 'a plain save expiring a row');
      t.no((cap.recall_history.payload.facts ?? []).some((f) => f.superseded_by !== null), 'a plain save creating a supersession link');
      t.no((cap.supersession_audit.payload.facts ?? []).length !== 0, 'the supersession audit gaining rows from plain saves');
    },
  },

  {
    id: '2.6',
    title: 'recall {supersessions:true} shows the full correction chain, newest first, expired rows only',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // A two-link correction chain: v1 → v2 → v3.
        const s1 = await save([
          { claim: 'Tessa works from the Denver office', provenance: 'user_stated', people: ['Tessa'] },
        ]);
        const v1 = s1.payload?.fact_ids?.[0];
        const s2 = await save([
          { claim: 'Tessa transferred to the Chicago office', provenance: 'user_stated', people: ['Tessa'], supersedes: v1 },
        ]);
        const v2 = s2.payload?.fact_ids?.[0];
        const s3 = await save([
          { claim: 'Tessa relocated to the Berlin office', provenance: 'user_stated', people: ['Tessa'], supersedes: v2 },
        ]);
        const v3 = s3.payload?.fact_ids?.[0];

        // The audit surface: only rows with BOTH markers (expired_at +
        // superseded_by), newest expiration first.
        const audit = await dispatch(engine, 'recall', { supersessions: true }, caller);
        const recallDefault = await dispatch(engine, 'recall', { entity: 'people/tessa' }, caller);

        return canonTimestamps({
          ids: { v1, v2, v3 },
          saves: [s1, s2, s3].map((s) => ({ isError: s.isError, payload: s.payload })),
          supersession_audit: { isError: audit.isError, payload: audit.payload },
          recall_default: { isError: recallDefault.isError, payload: recallDefault.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { v1, v2, v3 } = cap.ids;
      t.must(cap.saves.every((s) => s.isError === false) && cap.supersession_audit.isError === false && cap.recall_default.isError === false, 'every dispatch succeeds');
      t.must(cap.saves[1].payload.superseded === 1 && cap.saves[2].payload.superseded === 1, 'each correction applies exactly one supersession');

      const audit = cap.supersession_audit.payload.facts ?? [];
      const auditIds = audit.map((f) => f.id);

      // The audit is exactly the two expired links, newest expiration first.
      t.must(auditIds.length === 2 && auditIds[0] === v2 && auditIds[1] === v1, 'the audit lists exactly the two expired links, newest first');
      t.must(audit.every((f) => f.expired_at !== null && f.superseded_by !== null), 'every audit row carries BOTH markers');
      const byId = Object.fromEntries(audit.map((f) => [f.id, f]));
      t.must(byId[v1]?.superseded_by === v2, 'link 1: v1 points at v2');
      t.must(byId[v2]?.superseded_by === v3, 'link 2: v2 points at v3');

      // The live head NEVER appears in the audit; no row ever points at itself.
      t.no(auditIds.includes(v3), 'the active head appearing in the supersession audit');
      t.no(audit.some((f) => f.expired_at === null), 'an active row in the supersession audit');
      t.no(audit.some((f) => f.superseded_by === f.id), 'a row superseded by itself');

      // Default recall holds exactly the head of the chain.
      const defaultIds = (cap.recall_default.payload.facts ?? []).map((f) => f.id);
      t.must(defaultIds.length === 1 && defaultIds[0] === v3, 'default recall returns exactly the chain head');
    },
  },

  {
    id: '2.7',
    title: 'default recall drops the superseded value on every read surface; history keeps it',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        const s1 = await save([
          { claim: 'Ravi drives a diesel pickup', provenance: 'user_stated', people: ['Ravi'] },
        ]);
        const oldId = s1.payload?.fact_ids?.[0];
        const s2 = await save([
          { claim: 'Ravi switched to an electric hatchback', provenance: 'user_stated', people: ['Ravi'], supersedes: oldId },
        ]);
        const newId = s2.payload?.fact_ids?.[0];

        // Three read surfaces, all active-only by default: the entity view,
        // the recent-across-source view (no filter), and a grep. The stale
        // value appears in NONE of them. History (include_expired) keeps it.
        const byEntity = await dispatch(engine, 'recall', { entity: 'people/ravi' }, caller);
        const recent = await dispatch(engine, 'recall', {}, caller);
        const grepStale = await dispatch(engine, 'recall', { grep: 'diesel' }, caller);
        const history = await dispatch(engine, 'recall', { entity: 'people/ravi', include_expired: true }, caller);

        return canonTimestamps({
          ids: { oldId, newId },
          old_save: { isError: s1.isError, payload: s1.payload },
          correction: { isError: s2.isError, payload: s2.payload },
          recall_by_entity: { isError: byEntity.isError, payload: byEntity.payload },
          recall_recent: { isError: recent.isError, payload: recent.payload },
          recall_grep_stale: { isError: grepStale.isError, payload: grepStale.payload },
          recall_history: { isError: history.isError, payload: history.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { oldId, newId } = cap.ids;
      t.must([cap.old_save, cap.correction, cap.recall_by_entity, cap.recall_recent, cap.recall_grep_stale, cap.recall_history].every((s) => s.isError === false), 'every dispatch succeeds');

      const entityIds = (cap.recall_by_entity.payload.facts ?? []).map((f) => f.id);
      const recentIds = (cap.recall_recent.payload.facts ?? []).map((f) => f.id);

      // The superseded value NEVER surfaces on a default (active-only) read.
      t.no(entityIds.includes(oldId), 'the superseded value on the default entity view');
      t.no(recentIds.includes(oldId), 'the superseded value on the default recent view');
      t.no((cap.recall_grep_stale.payload.facts ?? []).length !== 0, 'the superseded value reachable via default grep');
      t.no(JSON.stringify(cap.recall_by_entity.payload).includes('diesel pickup'), 'the stale text leaking into the default entity payload');

      // The replacement is on both default surfaces; history keeps the pair.
      t.must(entityIds.includes(newId) && recentIds.includes(newId), 'the replacement appears on the default surfaces');
      const histById = Object.fromEntries((cap.recall_history.payload.facts ?? []).map((f) => [f.id, f]));
      t.must(histById[oldId]?.expired_at !== null && histById[oldId]?.superseded_by === newId, 'history keeps the corrected value with its chain');
      t.must(histById[newId]?.expired_at === null, 'the replacement is active in history too');
    },
  },

  {
    id: '2.8',
    title: 'invalid target (unknown / already-expired) leaves the old row intact — the chain is never rewritten',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // Seed: one row that will be legitimately corrected, one bystander.
        const s1 = await save([
          { claim: 'Ines keeps bees on the roof', provenance: 'user_stated', people: ['Ines'] },
          { claim: 'Ines sells honey at the weekend market', provenance: 'user_stated', people: ['Ines'] },
        ]);
        const roofId = s1.payload?.fact_ids?.[0];
        const marketId = s1.payload?.fact_ids?.[1];

        // The one REAL correction — establishes the chain roofId → gardenId
        // that the invalid attempts below must never rewrite.
        const s2 = await save([
          { claim: 'Ines moved the hives to the community garden', provenance: 'user_stated', people: ['Ines'], supersedes: roofId },
        ]);
        const gardenId = s2.payload?.fact_ids?.[0];

        // (a) dedup path + UNKNOWN target: the text dedups to gardenId, the
        // target id does not exist — expireFact updates nothing, counted 0.
        const dupUnknown = await save([
          { claim: 'Ines moved the hives to the community garden', provenance: 'user_stated', people: ['Ines'], supersedes: 424242 },
        ]);

        // (b) dedup path + ALREADY-EXPIRED target: roofId is already part of
        // the chain — the expired_at IS NULL guard makes it a no-op, counted
        // 0, and the existing link is never overwritten.
        const dupExpired = await save([
          { claim: 'Ines moved the hives to the community garden', provenance: 'user_stated', people: ['Ines'], supersedes: roofId },
        ]);

        // (c) insert path + UNKNOWN target: the new fact still lands. The
        // atomic path does not report whether the old row was touched, so the
        // counter reflects the DISPATCHED supersede (a documented engine
        // deviation) — but no row may actually expire.
        const insUnknown = await save([
          { claim: 'Ines won a blue ribbon at the county fair', provenance: 'user_stated', people: ['Ines'], supersedes: 515151 },
        ]);
        const ribbonId = insUnknown.payload?.fact_ids?.[0];

        // (d) insert path + ALREADY-EXPIRED target: the new fact lands; the
        // expired row's existing chain link is never rewritten.
        const insExpired = await save([
          { claim: 'Ines teaches a beekeeping class in spring', provenance: 'user_stated', people: ['Ines'], supersedes: roofId },
        ]);
        const classId = insExpired.payload?.fact_ids?.[0];

        const audit = await dispatch(engine, 'recall', { supersessions: true }, caller);
        const history = await dispatch(engine, 'recall', { entity: 'people/ines', include_expired: true }, caller);

        return canonTimestamps({
          ids: { roofId, marketId, gardenId, ribbonId, classId },
          seed: { isError: s1.isError, payload: s1.payload },
          real_correction: { isError: s2.isError, payload: s2.payload },
          dedup_unknown_target: { isError: dupUnknown.isError, payload: dupUnknown.payload },
          dedup_expired_target: { isError: dupExpired.isError, payload: dupExpired.payload },
          insert_unknown_target: { isError: insUnknown.isError, payload: insUnknown.payload },
          insert_expired_target: { isError: insExpired.isError, payload: insExpired.payload },
          supersession_audit: { isError: audit.isError, payload: audit.payload },
          recall_history: { isError: history.isError, payload: history.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { roofId, marketId, gardenId, ribbonId, classId } = cap.ids;
      t.must([cap.seed, cap.real_correction, cap.dedup_unknown_target, cap.dedup_expired_target, cap.insert_unknown_target, cap.insert_expired_target, cap.supersession_audit, cap.recall_history].every((s) => s.isError === false), 'every dispatch succeeds');

      // Dedup path counting is honest: an invalid target is NEVER counted.
      t.no(cap.dedup_unknown_target.payload.superseded !== 0, 'a dedup-path supersede counted against an unknown target');
      t.no(cap.dedup_expired_target.payload.superseded !== 0, 'a dedup-path supersede counted against an already-expired target');
      t.must(cap.dedup_unknown_target.payload.duplicate === 1 && cap.dedup_expired_target.payload.duplicate === 1, 'both dedup attempts still report the duplicate');

      // Insert path: the new fact ALWAYS lands even when the target is bad.
      t.must(cap.insert_unknown_target.payload.inserted === 1 && cap.insert_expired_target.payload.inserted === 1, 'the corrected fact lands even with a bad target');

      const audit = cap.supersession_audit.payload.facts ?? [];
      const histById = Object.fromEntries((cap.recall_history.payload.facts ?? []).map((f) => [f.id, f]));

      // The ONE real correction is the ONLY chain entry — four invalid
      // attempts NEVER expire a row or rewrite the existing link.
      t.no(audit.length !== 1, 'an invalid target growing the supersession audit');
      t.must(audit[0]?.id === roofId && audit[0]?.superseded_by === gardenId, 'the audit holds exactly the one real correction');
      t.no(histById[roofId]?.superseded_by !== gardenId, 'an already-expired row having its chain link rewritten');
      t.no(histById[marketId]?.expired_at !== null, 'a bystander row expiring from an invalid-target attempt');
      t.must([gardenId, ribbonId, classId].every((id) => histById[id]?.expired_at === null), 'all replacement rows are active');
      t.no(Object.values(histById).some((f) => f.superseded_by === f.id), 'a row superseded by itself');
    },
  },

  {
    id: '2.9',
    title: 'malformed supersedes rejects the whole batch by index — nothing lands, nothing expires',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        const s1 = await save([
          { claim: 'Vera plays the cello in a quartet', provenance: 'user_stated', people: ['Vera'] },
        ]);
        const seedId = s1.payload?.fact_ids?.[0];

        // Zero is not a fact id: the WHOLE batch rejects, naming index 1 —
        // the well-formed claim at index 0 is NOT saved.
        const zeroTarget = await save([
          { claim: 'Vera composes film scores on commission', provenance: 'user_stated', people: ['Vera'] },
          { claim: 'Vera sold her cello to fund a harp', provenance: 'user_stated', people: ['Vera'], supersedes: 0 },
        ]);

        // A float is not a fact id either — failing index reported honestly.
        const floatTarget = await save([
          { claim: 'Vera tours with a chamber ensemble', provenance: 'user_stated', people: ['Vera'], supersedes: 2.5 },
        ]);

        // Negative id — same whole-batch rejection.
        const negativeTarget = await save([
          { claim: 'Vera teaches masterclasses in autumn', provenance: 'user_stated', people: ['Vera'], supersedes: -3 },
        ]);

        const history = await dispatch(engine, 'recall', { entity: 'people/vera', include_expired: true }, caller);
        const audit = await dispatch(engine, 'recall', { supersessions: true }, caller);

        return canonTimestamps({
          ids: { seedId },
          seed: { isError: s1.isError, payload: s1.payload },
          zero_target: { isError: zeroTarget.isError, payload: zeroTarget.payload },
          float_target: { isError: floatTarget.isError, payload: floatTarget.payload },
          negative_target: { isError: negativeTarget.isError, payload: negativeTarget.payload },
          recall_history: { isError: history.isError, payload: history.payload },
          supersession_audit: { isError: audit.isError, payload: audit.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { seedId } = cap.ids;
      t.must(cap.seed.isError === false && cap.recall_history.isError === false && cap.supersession_audit.isError === false, 'seed and reads succeed');

      // Each malformed batch rejects as a schema error naming its index.
      t.must(cap.zero_target.payload?.error === 'invalid_claim', 'supersedes:0 rejects the batch as invalid_claim');
      t.must(cap.zero_target.payload?.failed_index === 1, 'the rejection names the failing index (1)');
      t.must(cap.float_target.payload?.error === 'invalid_claim' && cap.float_target.payload?.failed_index === 0, 'a float target rejects, naming index 0');
      t.must(cap.negative_target.payload?.error === 'invalid_claim' && cap.negative_target.payload?.failed_index === 0, 'a negative target rejects, naming index 0');

      // A rejected batch NEVER partially lands and NEVER expires anything.
      const facts = cap.recall_history.payload.facts ?? [];
      t.no(facts.length !== 1, 'a rejected batch leaving rows behind');
      t.must(facts[0]?.id === seedId && facts[0]?.expired_at === null && facts[0]?.superseded_by === null, 'the pre-existing row is untouched');
      t.no((cap.supersession_audit.payload.facts ?? []).length !== 0, 'a rejected batch touching the supersession audit');
      t.no(JSON.stringify([cap.zero_target.payload, cap.float_target.payload, cap.negative_target.payload]).includes('fact_ids'), 'a rejected batch returning fact ids');
    },
  },
];
