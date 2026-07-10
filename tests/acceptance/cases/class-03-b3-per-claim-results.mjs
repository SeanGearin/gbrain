// Class 3 — B3: save_facts per-claim results[] (commit de3c505f).
//
// save_facts always computed every per-claim outcome and then threw the
// attribution away: fact_ids SKIPS dropped claims, so a positional zip of
// fact_ids against the request misattributes every claim after the first
// restricted-data drop. B3 adds `results` — EXACTLY one entry per INPUT
// claim, ordered by request index — so the caller can tell the user which
// memory landed, which matched an existing one, and which was refused and
// why. The contract locked here, black-box through dispatchToolCall on the
// customer plane:
//   - dense + index-aligned: results[i].index === i for every input claim,
//     across mixed batches (inserts, duplicates, drops interleaved),
//   - statuses honest: 'inserted' (fact_id = new row), 'duplicate'
//     (fact_id = the canonical existing row), 'dropped' (category only —
//     one of the engine's named restricted classes payment_card / ssn /
//     credential; NO fact_id key, and the dropped value never appears
//     anywhere in the response),
//   - fact_ids keeps its skip-drops shape (existing callers unbroken),
//   - positional back-compat: when dropped === 0, results[i].fact_id ===
//     fact_ids[i] for every i,
//   - B2 interplay: a superseding insert reads 'inserted' (it IS a new
//     row; the batch `superseded` counter reports the chain), while
//     duplicate+supersedes reads 'duplicate' with the canonical id,
//   - B4 interplay: a restricted SURFACE FORM (e.g. an SSN in entities[])
//     is a strip, not a drop — the claim is kept, `dropped` stays 0, and
//     its result reads 'inserted'. The receipt never conflates the two.

import { makeEngine, customerCaller, dispatch, canonTimestamps } from '../_harness.mjs';

export const meta = { class: 3, title: 'B3 — save_facts per-claim results (index-aligned receipt)', requires: 'b3_results' };

const SOURCE = 'accept-b3';

// The restricted values fed to the drop/strip cases. Asserted ABSENT from
// every serialized response — the categories are reported, the values never.
const SSN_VALUE = '123-45-6789';
const CARD_VALUE = '4111 1111 1111 1111';
const CARD_DIGITS = '4111111111111111';
const CREDENTIAL_VALUE = 'sk-TESTKEYTESTKEYTEST1234';

/** Every restricted string (and its digit-collapsed card form) as needles. */
const RESTRICTED_NEEDLES = [SSN_VALUE, CARD_VALUE, CARD_DIGITS, CREDENTIAL_VALUE];

function assertNoRestrictedEcho(cap, t) {
  const serialized = JSON.stringify(cap);
  for (const needle of RESTRICTED_NEEDLES) {
    t.no(serialized.includes(needle), `a dropped/stripped restricted value echoed in the response (${needle.slice(0, 6)}…)`);
  }
}

export const cases = [
  {
    id: '3.1',
    title: 'mixed batch: dense index-aligned receipt across drops; honest categories; fact_ids keeps its skip shape',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);

        // One batch interleaving every outcome: insert, ssn drop, in-batch
        // duplicate, card drop, second insert, credential drop. The old
        // positional zip breaks at index 1; results must not.
        const save = await dispatch(engine, 'save_facts', {
          claims: [
            { claim: 'Marcus renewed the Fairview office lease', provenance: 'user_stated', people: ['Marcus'] },
            { claim: `Marcus read his ssn as ${SSN_VALUE} during onboarding`, provenance: 'user_stated', people: ['Marcus'] },
            { claim: 'Marcus renewed the Fairview office lease', provenance: 'user_stated', people: ['Marcus'] },
            { claim: `Marcus pinned the corporate card ${CARD_VALUE} for travel bookings`, provenance: 'user_stated', people: ['Marcus'] },
            { claim: 'Marcus prefers the metro over driving downtown', provenance: 'model_inferred', people: ['Marcus'] },
            { claim: `Marcus pasted the gateway key ${CREDENTIAL_VALUE} into the thread`, provenance: 'user_stated', people: ['Marcus'] },
          ],
        }, caller);

        // Only the two inserted memories exist afterwards — a dropped claim
        // was never written, so recall can never resurface it.
        const recall = await dispatch(engine, 'recall', { entity: 'people/marcus' }, caller);

        return canonTimestamps({
          save: { isError: save.isError, payload: save.payload },
          recall: { isError: recall.isError, payload: recall.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must(cap.save.isError === false && cap.recall.isError === false, 'both dispatches succeed');
      const p = cap.save.payload;
      const results = p?.results ?? [];

      // Dense + index-aligned: one entry per INPUT claim, results[i].index === i.
      t.must(results.length === 6, 'results carries exactly one entry per input claim');
      t.no(results.some((r, i) => !r || r.index !== i), 'a sparse or misaligned results entry (results[i].index !== i)');

      // Statuses honest across the mix, in request order.
      t.must(
        JSON.stringify(results.map((r) => r.status)) ===
          JSON.stringify(['inserted', 'dropped', 'duplicate', 'dropped', 'inserted', 'dropped']),
        'statuses read [inserted, dropped, duplicate, dropped, inserted, dropped] in request order',
      );
      t.must(
        results[1]?.category === 'ssn' && results[3]?.category === 'payment_card' && results[5]?.category === 'credential',
        'each dropped entry names its engine category (ssn / payment_card / credential)',
      );

      // A dropped entry NEVER carries a fact_id; a kept entry always does.
      t.no(results.some((r) => r.status === 'dropped' && 'fact_id' in r), 'a dropped entry carrying a fact_id key');
      t.no(results.some((r) => r.status !== 'dropped' && typeof r.fact_id !== 'number'), 'a kept entry missing its fact_id');
      t.no(results.some((r) => r.status !== 'dropped' && 'category' in r), 'a kept entry carrying a drop category');

      // The in-batch duplicate resolves to the row index 0 inserted.
      t.must(results[2]?.fact_id === results[0]?.fact_id, 'the duplicate attributes to the canonical row from index 0');

      // fact_ids keeps its skip-drops shape: the kept entries, in order.
      t.must(
        JSON.stringify(p.fact_ids) === JSON.stringify([results[0]?.fact_id, results[2]?.fact_id, results[4]?.fact_id]),
        'fact_ids equals the kept results in request order (3 entries for 6 claims)',
      );

      // Counters agree with the receipt.
      t.must(p.inserted === 2 && p.duplicate === 1 && p.dropped === 3 && p.superseded === 0, 'counters read inserted:2 duplicate:1 dropped:3 superseded:0');

      // Dropped claims were never written: recall shows only the two inserts.
      t.must(cap.recall.payload?.total === 2, 'recall returns exactly the two inserted memories');
      t.no(
        (cap.recall.payload?.facts ?? []).some((f) => f.id !== results[0].fact_id && f.id !== results[4].fact_id),
        'recall resurfacing a row outside the two inserted fact_ids',
      );

      // The refused values NEVER appear anywhere in any response.
      assertNoRestrictedEcho(cap, t);
    },
  },
  {
    id: '3.2',
    title: 'clean batch: positional back-compat — results zips exactly onto fact_ids when nothing was dropped',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);

        // Three lexically distinct memories plus an exact in-batch duplicate
        // of the second — nothing dropped, so the OLD positional contract
        // (fact_ids[i] ↔ claims[i]) must still hold, entry for entry.
        const save = await dispatch(engine, 'save_facts', {
          claims: [
            { claim: 'Rosa runs the ceramics studio on Alameda', provenance: 'user_stated', people: ['Rosa'] },
            { claim: 'Rosa is training for the Ventura triathlon', provenance: 'user_stated', people: ['Rosa'] },
            { claim: 'Rosa keeps the kiln logs in a paper binder', provenance: 'user_stated', people: ['Rosa'] },
            { claim: 'Rosa is training for the Ventura triathlon', provenance: 'user_stated', people: ['Rosa'] },
          ],
        }, caller);

        return canonTimestamps({ save: { isError: save.isError, payload: save.payload } });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must(cap.save.isError === false, 'the dispatch succeeds');
      const p = cap.save.payload;
      const results = p?.results ?? [];

      t.must(p.dropped === 0, 'a fully clean batch drops nothing');
      t.no(results.some((r) => r.status === 'dropped'), 'a dropped entry in a clean batch');
      t.must(results.length === 4 && p.fact_ids?.length === 4, 'results and fact_ids both carry one entry per claim');
      t.no(results.some((r, i) => r.index !== i), 'a misaligned results entry in a clean batch');

      // THE back-compat contract: with dropped === 0, the positional zip is exact.
      t.no(results.some((r, i) => r.fact_id !== p.fact_ids[i]), 'results[i].fact_id diverging from fact_ids[i] when nothing was dropped');

      t.must(
        JSON.stringify(results.map((r) => r.status)) === JSON.stringify(['inserted', 'inserted', 'inserted', 'duplicate']),
        'statuses read [inserted, inserted, inserted, duplicate]',
      );
      t.must(results[3]?.fact_id === results[1]?.fact_id, 'the in-batch duplicate attributes to its canonical row');
      t.must(p.inserted === 3 && p.duplicate === 1 && p.superseded === 0, 'counters read inserted:3 duplicate:1 superseded:0');
    },
  },
  {
    id: '3.3',
    title: 'B2 interplay: a superseding insert reads inserted; duplicate+supersedes reads duplicate with the canonical id',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);
        const save = (claims) => dispatch(engine, 'save_facts', { claims }, caller);

        // The value that will be corrected.
        const s1 = await save([
          { claim: 'Noah lives in Silver Lake', provenance: 'user_stated', people: ['Noah'] },
        ]);
        const silverLakeId = s1.payload?.fact_ids?.[0];

        // INSERT-path correction: a new row that supersedes the old one. Its
        // receipt reads 'inserted' — it IS a new row; the batch `superseded`
        // counter carries the chain.
        const s2 = await save([
          { claim: 'Noah moved to Echo Park at the start of summer', provenance: 'user_stated', people: ['Noah'], supersedes: silverLakeId },
        ]);
        const echoParkId = s2.payload?.fact_ids?.[0];

        // A second plain value (the dedup-path supersede target).
        const s3 = await save([
          { claim: 'Noah fosters retired greyhounds', provenance: 'user_stated', people: ['Noah'] },
        ]);
        const greyhoundId = s3.payload?.fact_ids?.[0];

        // DEDUP-path correction: text already canonical as echoParkId — no
        // new row, receipt reads 'duplicate' with the canonical id, and the
        // supersede still applies.
        const s4 = await save([
          { claim: 'Noah moved to Echo Park at the start of summer', provenance: 'user_stated', people: ['Noah'], supersedes: greyhoundId },
        ]);

        return canonTimestamps({
          ids: { silverLakeId, echoParkId, greyhoundId },
          plain_save: { isError: s1.isError, payload: s1.payload },
          insert_path_correction: { isError: s2.isError, payload: s2.payload },
          second_plain_save: { isError: s3.isError, payload: s3.payload },
          dedup_path_correction: { isError: s4.isError, payload: s4.payload },
        });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      const { silverLakeId, echoParkId, greyhoundId } = cap.ids;
      const saves = [cap.plain_save, cap.insert_path_correction, cap.second_plain_save, cap.dedup_path_correction];
      t.must(saves.every((s) => s.isError === false), 'every dispatch succeeds');

      // Every one of these single-claim batches is drop-free — the positional
      // zip and the dense receipt both hold on all four.
      for (const s of saves) {
        const r = s.payload?.results ?? [];
        t.must(r.length === 1 && r[0]?.index === 0, 'a single-claim batch yields exactly one index-0 entry');
        t.no(r.some((x, i) => x.fact_id !== s.payload.fact_ids[i]), 'results diverging from fact_ids on a drop-free batch');
      }

      // Superseding INSERT reads 'inserted' with the NEW row id.
      const ins = cap.insert_path_correction.payload;
      t.must(ins.results[0].status === 'inserted', 'a superseding insert reads inserted');
      t.must(ins.results[0].fact_id === echoParkId, 'the superseding insert carries the new row id');
      t.no(ins.results[0].fact_id === silverLakeId, 'a superseding insert reusing the superseded row id');
      t.must(ins.superseded === 1, 'the chain is reported by the batch superseded counter');

      // duplicate+supersedes reads 'duplicate' with the CANONICAL id.
      const dup = cap.dedup_path_correction.payload;
      t.must(dup.results[0].status === 'duplicate', 'duplicate+supersedes reads duplicate');
      t.must(dup.results[0].fact_id === echoParkId, 'the duplicate attributes to the canonical row, not the supersede target');
      t.no(dup.results[0].fact_id === greyhoundId, 'a duplicate receipt pointing at the row it expired');
      t.must(dup.inserted === 0 && dup.duplicate === 1 && dup.superseded === 1, 'dedup-path correction writes no row and still applies the supersede');

      // A supersession is NEVER a per-claim status of its own.
      t.no(
        saves.some((s) => (s.payload?.results ?? []).some((r) => r.status !== 'inserted' && r.status !== 'duplicate' && r.status !== 'dropped')),
        'a results status outside inserted | duplicate | dropped',
      );
    },
  },
  {
    id: '3.4',
    title: 'B4 interplay: a restricted surface form is a strip, not a drop — the claim keeps its inserted receipt',
    async run() {
      const { engine, close } = await makeEngine([SOURCE]);
      try {
        const caller = customerCaller(SOURCE);

        // Clean claim TEXT, restricted data in a structured surface form: an
        // SSN co-mentioned in entities[]. B4 strips the surface form and
        // KEEPS the claim — the receipt must read a plain insert, because a
        // co-mention is not worth a whole memory and the caller must not be
        // told their memory was refused when it wasn't.
        const save = await dispatch(engine, 'save_facts', {
          claims: [
            {
              claim: 'Dana joined the finance team this quarter',
              provenance: 'user_stated',
              people: ['Dana'],
              entities: ['Beacon Properties', SSN_VALUE],
            },
          ],
        }, caller);

        return canonTimestamps({ save: { isError: save.isError, payload: save.payload } });
      } finally {
        await close();
      }
    },
    never(cap, t) {
      t.must(cap.save.isError === false, 'the dispatch succeeds');
      const p = cap.save.payload;

      // A strip NEVER masquerades as a drop.
      t.no(p.dropped !== 0, 'a surface-form strip counted as a dropped claim');
      t.no((p.results ?? []).some((r) => r.status === 'dropped'), 'a dropped results entry for a kept claim');
      t.must(p.inserted === 1 && p.results?.length === 1, 'the claim inserts and yields exactly one receipt entry');
      t.must(p.results?.[0]?.index === 0 && p.results?.[0]?.status === 'inserted', 'the receipt reads a plain index-0 insert');
      t.must(p.results?.[0]?.fact_id === p.fact_ids?.[0], 'positional back-compat holds (nothing was dropped)');

      // The stripped value NEVER appears in the response.
      assertNoRestrictedEcho(cap, t);
    },
  },
];
