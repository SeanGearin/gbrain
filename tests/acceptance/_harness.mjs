// tests/acceptance/_harness.mjs
// Shared toolkit for the engine acceptance corpus (see README.md here).
//
// Mirrors virgil-worker tests/acceptance/_harness.mjs discipline: golden-exact
// captures, byte-identical repeat runs, loud PENDING when a feature is absent,
// NEVER-happens assertions on every execution. Runs under BUN (the case
// surface imports the engine's TypeScript through its public seams).
//
// TEST ASSETS ONLY. This file never ships. Everything runs on an in-memory
// PGLite engine — no DATABASE_URL, no provider keys, no network, no box.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Feature probes — which staged engine feature is present in THIS checkout.
// The staged features change existing files (no marker files exist), so each
// probe is file + needle: the needle is a load-bearing line the feature commit
// added and the box base (b0b681ee) provably lacks. A case whose probe misses
// reports PENDING — loudly, never silently — and never imports engine code.
//
//   b1_provenance  04882e1f  recall fact rows project the v114 provenance stamp
//   b2_supersedes  2b8f9265  save_facts claims accept `supersedes` (atomic correction)
//   b3_results     de3c505f  save_facts returns per-claim results[] (index-aligned)
// ─────────────────────────────────────────────────────────────────────────────
export const PROBES = {
  b1_provenance: { file: 'src/core/operations.ts', needle: 'provenance: r.provenance ?? null' },
  b2_supersedes: { file: 'src/core/facts/save.ts', needle: 'supersedes: z.number().int().positive().optional()' },
  b3_results: { file: 'src/core/facts/save.ts', needle: 'SaveFactsClaimResult' },
};

export function probeFeatures() {
  const out = {};
  for (const [name, { file, needle }] of Object.entries(PROBES)) {
    const p = join(repoRoot, file);
    out[name] = existsSync(p) && readFileSync(p, 'utf8').includes(needle);
  }
  return out;
}

export function missingFeatures(requires) {
  const req = Array.isArray(requires) ? requires : [requires];
  const have = probeFeatures();
  return req.filter((r) => !have[r]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Determinism.
//
// Seeded randomness mirrors the worker harness verbatim. The clock is NOT
// frozen — a deliberate, documented deviation: the engine's row timestamps
// (created_at, valid_from, expired_at) originate in SQL now() inside WASM
// Postgres, which a JS Date patch cannot reach. Instead every capture passes
// through canonTimestamps() (below), which rewrites each ISO-8601 timestamp
// string to a positional token (<t1>, <t2>, …) in stable walk order. Null
// stays null — "expired_at flipped from null to a timestamp" survives
// canonicalization, so the goldens still lock the supersession chain. The
// runner then executes every case TWICE on fresh engines and requires the
// canonical captures to be byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
function makeLcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

export async function withDeterminism(fn, { seed = 0xacce97 } = {}) {
  const next = makeLcg(seed);
  const realMathRandom = Math.random;
  const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const realRandomUUID = globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : null;

  Math.random = () => next() / 0x100000000;
  globalThis.crypto.getRandomValues = (arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
    return arr;
  };
  if (realRandomUUID) {
    globalThis.crypto.randomUUID = () => {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
  }
  try {
    return await fn();
  } finally {
    Math.random = realMathRandom;
    globalThis.crypto.getRandomValues = realGetRandomValues;
    if (realRandomUUID) globalThis.crypto.randomUUID = realRandomUUID;
  }
}

// Full-string ISO-8601 timestamp (what toISOString and PG rows emit).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Replace every ISO-timestamp STRING VALUE in a JSON-safe structure with a
 * positional token: <t1>, <t2>, … assigned in deterministic walk order
 * (object keys in insertion order, arrays in index order). Each occurrence
 * gets its OWN token — value-dedup would flake when two wall-clock reads
 * straddle a millisecond boundary in one run and not the other. Nulls,
 * numbers, and non-timestamp strings pass through untouched.
 */
export function canonTimestamps(value) {
  let n = 0;
  const walk = (v) => {
    if (typeof v === 'string') return ISO_RE.test(v) ? `<t${++n}>` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// NO-NETWORK sentinel. The save/recall paths under test are zero-LLM by
// contract — any http(s) fetch during a case is a violated NEVER, recorded
// and thrown. Non-http schemes delegate to the real fetch (PGLite loads its
// WASM locally; nothing on these paths should hit even that, but the sentinel
// polices the network, not the filesystem).
// ─────────────────────────────────────────────────────────────────────────────
export const fetchEscapes = [];

export function installNoNetworkSentinel() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/^https?:/i.test(url)) {
      fetchEscapes.push(url);
      throw new Error(`acceptance no-network sentinel: fetch(${url})`);
    }
    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine + dispatch builders. Every case run() gets a FRESH in-memory PGLite
// engine (fresh serial id space → fact ids are deterministic), seeds its
// tenant rows in sources (facts.source_id FK), drives the PUBLIC op layer
// through dispatchToolCall — the exact seam the MCP transports use — and
// closes the engine in finally. Engine modules are imported lazily so a
// PENDING checkout never loads engine code.
// ─────────────────────────────────────────────────────────────────────────────
export async function makeEngine(sourceIds = []) {
  const { PGLiteEngine } = await import(pathToFileURL(join(repoRoot, 'src/core/pglite-engine.ts')).href);
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of sourceIds) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
  return { engine, close: () => engine.disconnect() };
}

/**
 * The customer-plane caller shape: a source-bound, non-default OAuth client
 * (auth.sourceId === the one allowedSources entry). This is what flips
 * isCustomerScopedRemoteRead(ctx) → the source_session strip — AND the
 * recall owner-visibility carve-out (a tenant reads its own private rows).
 */
export function customerCaller(sourceId) {
  return {
    remote: true,
    sourceId,
    auth: {
      token: 'acceptance-token',
      clientId: 'acceptance-client',
      clientName: 'Acceptance Client',
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId],
    },
  };
}

/** dispatchToolCall + envelope parse: { isError, payload }. */
export async function dispatch(engine, name, args, opts) {
  const { dispatchToolCall } = await import(pathToFileURL(join(repoRoot, 'src/mcp/dispatch.ts')).href);
  const r = await dispatchToolCall(engine, name, args, opts);
  let payload = null;
  try { payload = JSON.parse(r.content?.[0]?.text ?? 'null'); } catch { payload = r.content?.[0]?.text ?? null; }
  return { isError: r.isError === true, payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden plumbing — verbatim worker-harness semantics.
// ─────────────────────────────────────────────────────────────────────────────
export function readGolden(caseId) {
  const p = join(here, 'expected', `${caseId}.json`);
  if (!existsSync(p)) return { exists: false, value: null };
  return { exists: true, value: JSON.parse(readFileSync(p, 'utf8')) };
}

/** First path where two JSON-safe values differ, or null when equal. */
export function firstDiff(actual, expected, path = '$') {
  if (actual === expected) return null;
  const ta = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
  const te = expected === null ? 'null' : Array.isArray(expected) ? 'array' : typeof expected;
  if (ta !== te) return `${path}: type ${ta} != expected ${te}`;
  if (ta === 'array') {
    if (actual.length !== expected.length) return `${path}: length ${actual.length} != expected ${expected.length}`;
    for (let i = 0; i < actual.length; i++) {
      const d = firstDiff(actual[i], expected[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === 'object') {
    const ka = Object.keys(actual);
    const ke = Object.keys(expected);
    for (const k of ke) if (!(k in actual)) return `${path}.${k}: missing (expected present)`;
    for (const k of ka) if (!(k in expected)) return `${path}.${k}: unexpected key`;
    for (const k of ke) {
      const d = firstDiff(actual[k], expected[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`;
}
