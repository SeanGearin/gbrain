#!/usr/bin/env bun
// Engine acceptance-corpus runner. Mirrors virgil-worker tests/acceptance
// semantics: exit 0 = every RUNNABLE case matches its golden exactly AND
// repeats byte-identically; any mismatch prints a path-level diff, exit 1.
//
//   bun tests/acceptance/run.mjs                # verify
//   bun tests/acceptance/run.mjs --record       # (re)write goldens — see README
//   bun tests/acceptance/run.mjs --only=2       # one class (B2)
//   bun tests/acceptance/run.mjs --only=2.1     # one case
//
// BUN, not node — cases import the engine's TypeScript through its public
// seams (dispatchToolCall, PGLiteEngine).
//
// A case whose required feature is absent from this checkout reports PENDING —
// counted and listed loudly, never silently skipped. PENDING does not fail the
// run: the corpus is the TARGET contract for the staged B1/B2/B3 features; on
// the box base (b0b681ee) everything pends and the runner exits 0. See
// README.md for the probe table.
//
// Cases run strictly SEQUENTIALLY — determinism patches (crypto seeding, the
// no-network sentinel) are global. Do not parallelize this runner.

import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withDeterminism, missingFeatures, probeFeatures, firstDiff, readGolden,
  installNoNetworkSentinel, fetchEscapes,
} from './_harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, 'cases');
const expectedDir = join(here, 'expected');

const argv = process.argv.slice(2);
const RECORD = argv.includes('--record');
const only = (argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');

function wanted(caseId) {
  if (!only) return true;
  if (only.includes('.')) return caseId === only;
  return caseId.split('.')[0] === only;
}

// Reporter passed to case.never(capture, t): t.no() asserts the NEVER-happens
// column (condition must be false), t.must() guards expected behavior a golden
// alone can't express.
function makeT() {
  const failures = [];
  return {
    failures,
    no(cond, label) { if (cond) failures.push(`NEVER violated: ${label}`); },
    must(cond, label) { if (!cond) failures.push(`expected: ${label}`); },
  };
}

const classFiles = readdirSync(casesDir).filter((f) => /^class-\d{2}-.*\.mjs$/.test(f)).sort();
if (classFiles.length === 0) {
  console.error('no case files found under tests/acceptance/cases/');
  process.exit(1);
}

const features = probeFeatures();
console.log(`\nengine acceptance corpus — features present: ${Object.entries(features).map(([k, v]) => `${k}=${v ? 'yes' : 'NO'}`).join(', ')}\n`);

let passed = 0;
let failed = 0;
let recorded = 0;
const pending = [];

for (const file of classFiles) {
  const mod = await import(join(casesDir, file));
  const meta = mod.meta || {};
  const cases = mod.cases || [];
  const shown = cases.filter((c) => wanted(c.id));
  if (shown.length === 0) continue;
  console.log(`── class ${meta.class ?? '?'} — ${meta.title ?? file}`);

  for (const c of shown) {
    const requires = c.requires ?? meta.requires;
    const missing = missingFeatures(requires);
    if (missing.length) {
      pending.push({ id: c.id, title: c.title, missing });
      console.log(`  PEND  ${c.id} ${c.title}  (needs: ${missing.join(', ')})`);
      continue;
    }

    try {
      // Run twice, each on a FRESH engine — canonical captures must be
      // byte-identical or the case fails. The no-network sentinel is armed
      // for both runs: any http(s) fetch on these zero-LLM paths fails loud.
      fetchEscapes.length = 0;
      const restoreFetch = installNoNetworkSentinel();
      let cap1;
      let cap2;
      try {
        cap1 = await withDeterminism(() => c.run());
        cap2 = await withDeterminism(() => c.run());
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        restoreFetch();
      }
      if (fetchEscapes.length) {
        console.log(`  FAIL  ${c.id} ${c.title}: ${fetchEscapes.length} network fetch(es) on a zero-LLM path — first: ${fetchEscapes[0]}`);
        failed++;
        continue;
      }
      const s1 = JSON.stringify(cap1);
      const s2 = JSON.stringify(cap2);
      if (s1 !== s2) {
        console.log(`  FAIL  ${c.id} ${c.title}: NON-DETERMINISTIC — two runs differ`);
        const d = firstDiff(JSON.parse(s2), JSON.parse(s1));
        if (d) console.log(`        first drift at ${d}`);
        failed++;
        continue;
      }

      // NEVER-happens assertions run on every execution, record or verify —
      // a golden must never be minted over a violated contract.
      const t = makeT();
      if (typeof c.never === 'function') c.never(cap1, t);
      if (t.failures.length) {
        for (const f of t.failures) console.log(`  FAIL  ${c.id} ${c.title}: ${f}`);
        failed++;
        continue;
      }

      if (RECORD) {
        mkdirSync(expectedDir, { recursive: true });
        writeFileSync(join(expectedDir, `${c.id}.json`), `${JSON.stringify(JSON.parse(s1), null, 2)}\n`);
        console.log(`  REC   ${c.id} ${c.title}`);
        recorded++;
        continue;
      }

      const golden = readGolden(c.id);
      if (!golden.exists) {
        console.log(`  FAIL  ${c.id} ${c.title}: no golden recorded (expected/${c.id}.json missing)`);
        failed++;
        continue;
      }
      const diff = firstDiff(JSON.parse(s1), golden.value);
      if (diff) {
        console.log(`  FAIL  ${c.id} ${c.title}: ${diff}`);
        failed++;
      } else {
        console.log(`  PASS  ${c.id} ${c.title}`);
        passed++;
      }
    } catch (e) {
      console.log(`  FAIL  ${c.id} ${c.title}: threw ${e && e.message}`);
      if (e && e.stack) console.log(`        ${e.stack.split('\n').slice(1, 3).join('\n        ')}`);
      failed++;
    }
  }
}

if (pending.length) {
  console.log(`\npending (feature absent in this checkout — the corpus lights up on deploy of the staged commits):`);
  for (const p of pending) console.log(`  - ${p.id} ${p.title}  [needs ${p.missing.join(', ')}]`);
}

if (RECORD) console.log(`\nacceptance: ${recorded} recorded, ${failed} failed, ${pending.length} pending\n`);
else console.log(`\nacceptance: ${passed} passed, ${failed} failed, ${pending.length} pending\n`);
process.exit(failed === 0 ? 0 : 1);
