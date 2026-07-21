/**
 * B7 save_facts (pass 1) — deterministic graph construct from structured facts.
 *
 * The missing "Construct" step (CC packet 2026-06-15, verdict B: absent-but-
 * buildable). `save_facts`'s `buildContext` folds each claim's people[]/entities[]
 * into the fact's plaintext `context` column and leaves `entity_slug` NULL, so a
 * tenant brain seeded entirely through save_facts has a FULL recall surface but
 * an EMPTY graph (0 pages, 0 links). `traverse_graph` / `find_experts` have
 * nothing to walk. This composes the existing LLM-free primitives into the
 * per-fact construct that turns those arrays into entity pages + edges.
 *
 *   1. each name in people[] (person) / entities[] (company) → the standard
 *      source-scoped entity resolver, with an existing exact / fuzzy / prefix
 *      page reused as-is and a typed stub minted only on fallback_slugify;
 *   2. BIDIRECTIONAL entity↔entity co-occurrence edges between every co-mentioned
 *      pair. Bidirectional because `traverseGraph` walks `from_page_id →
 *      to_page_id` ONLY (postgres-engine.ts:2381 / pglite parity) — a single
 *      direction would be invisible when the walk seeds from the other endpoint.
 *
 * COST — per fact: 0 chat-model calls, 0 embedding calls. Pure SQL + a pure
 * text-split: N slug string-ops + ≤N page upserts + ≤N stub-chunk upserts +
 * 1 batched edge insert. Passes the zero-LLM-per-fact economic gate by
 * construction (the customer's own model already paid for the cognition that
 * produced the arrays; turning them into a graph is DB work). This module
 * imports nothing from the AI gateway — `chunkText` is a pure local splitter.
 *
 * SEARCHABILITY (findings 2026-06-17 — the search_brain-empty root cause).
 *   `search_brain`/`query` is hybrid search over `content_chunks`. A stub
 *   created via the low-level `putPage` alone produces a page row with ZERO
 *   chunks, so the entity is invisible to semantic search even though `recall`
 *   (facts table) and `brain_check` (page count) see it. Fix: every NEW stub
 *   also gets its `compiled_truth` chunked into `content_chunks` here, the SAME
 *   chunkText→upsertChunks pair the authored put_page path uses (import-file.ts).
 *   Chunks land with NULL embedding — the `chunk_search_vector_trigger` makes
 *   them keyword-searchable immediately; the existing `embed --stale` pass fills
 *   the vector arm later. This keeps the "0 embedding calls here" contract (the
 *   embed is deferred + external, exactly as `reindex` defers it), so the
 *   tenant-plane FLAG-C discipline is untouched.
 *
 * MATERIALIZATION (CC packet 2026-06-18 — the search_brain root cause, deeper).
 *   Chunking the stub alone is NOT enough: the stub body carries the entity
 *   NAME but ZERO fact substance, so a "Boltline" query title-matches the stub
 *   while the entity's real facts (in the facts table) never reach the chunk
 *   arm. `materializeEntityPages` closes this: after save_facts inserts a batch,
 *   it rebuilds each touched entity's `compiled_truth` from that entity's own
 *   ACTIVE facts (a deterministic facts→markdown compile — `compileEntityBody`,
 *   NO chat model) and re-chunks it, so the chunk arm retrieves fact text, not a
 *   skeleton. Unlike `ensureStub` (one-shot, new pages only) it rebuilds across
 *   the whole active fact set and on every batch, so a multi-fact entity and a
 *   pre-existing page both converge. Chunk embeddings reuse the SAME ZeroEntropy
 *   zembed-1 lane the facts use (injected, best-effort) — zero added model
 *   inference; keyword search works immediately even if that lane is down.
 *
 * TENANT-PLANE DISCIPLINE (CC packet "where the real care goes"):
 *   - LOW-LEVEL direct writes only — `engine.putPage` / `engine.upsertChunks` /
 *     `engine.addLinksBatch`, NOT the `put_page` OP. The op's post-write hooks
 *     (auto_link, write-through render) are the FLAG-C config-read / embedding
 *     surface the b7 series keeps OFF the tenant plane; these engine methods are
 *     plain upserts/inserts called inside the caller's tx — the same pair
 *     `importFromContent` runs inside its own transaction (import-file.ts:766/816).
 *   - CONFIG-FREE — no getConfig. Runs inside the caller's withSourceScope tx
 *     under the NOBYPASSRLS gbrain_tenant role; a raw config read there aborts
 *     the whole tx (the FLAG-C class).
 *   - STUBS BEFORE EDGES — `addLinksBatch` INNER-JOINs both endpoints on
 *     (slug, source_id) and silently DROPS any edge whose endpoint page is
 *     missing. Every stub is putPage'd first; same tx → same-tx read visibility,
 *     so the edge batch sees the rows written microseconds earlier.
 *   - SOURCE-SCOPED — every putPage passes { sourceId } and every edge carries
 *     from_source_id = to_source_id = sourceId. Without the edge source ids the
 *     JOIN defaults to source 'default' and every edge silently vanishes.
 *   - NON-THROWING by construction — names that slugify to an empty body are
 *     skipped (never a junk `people/` page); the only external calls are upserts
 *     and an ON-CONFLICT-DO-NOTHING insert that cannot throw on valid input. A
 *     genuine infra error propagates and aborts the tx atomically with the fact
 *     insert — never a half-built graph. (Savepoint-isolating construct failure
 *     from the fact insert is a possible hardening; deliberately out of scope for
 *     this first build — see the findings doc.)
 *
 * STANDARD ENTITY RESOLUTION. `resolveEntitySlugWithSource` is already
 * source-scoped and pure SQL: exact page → fuzzy/prefix existing page →
 * fallback slugify. The construct uses that resolver through the SAME engine it
 * was handed by save_facts. On the tenant plane that engine is the
 * withSourceScope transaction handle, preserving the red-team isolation proof;
 * there is no fresh engine, config read, model call, or embedding call here.
 */

import type { BrainEngine, LinkBatchInput, FactRow } from '../engine.ts';
import type { ChunkInput, Page } from '../types.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { slugifyEntity } from '../enrichment-service.ts';
import { isAvailable } from '../ai/gateway.ts';
import { embedBatch, currentEmbeddingSignature } from '../embedding.ts';

/**
 * `link_source = 'manual'` — NOT 'markdown'. The links.link_source CHECK
 * constraint allows only 'markdown' | 'frontmatter' | 'manual' | NULL, and the
 * choice is load-bearing, not a workaround: 'markdown' edges are owned by the
 * text-reconciliation sweeps (extract / reconcile-links DELETE stale markdown
 * links not present in a page's current body, and put_page reconciles
 * 'frontmatter' edges). Our stub pages carry no [[wikilinks]] in their body, so
 * a 'markdown' co-occurrence edge would be reconciled AWAY on the next sweep.
 * 'manual' is the "asserted, not text-derived, never auto-reconciled" lane —
 * exactly what a programmatically-built co-occurrence edge is. (A dedicated
 * 'save_facts' link_source would need a one-line constraint extension; deferred
 * to keep this build schema-free — see the findings doc.)
 */
const LINK_SOURCE = 'manual';
/**
 * The real attribution discriminator (link_type is unconstrained): every
 * construct edge is queryable as `WHERE link_type = 'co_occurrence'`. Symmetric
 * relation — same type in both directions (unlike asymmetric documents /
 * documented_by), which is why both directions are inserted explicitly below.
 */
const LINK_TYPE = 'co_occurrence';

/**
 * Resolver fuzzy threshold. Kept as the standard resolver default (>= 0.4) and
 * named here so the construct's merge tolerance has one obvious tuning point.
 */
const ENTITY_RESOLUTION_FUZZY_THRESHOLD = 0.4;

/**
 * Per-fact cap on entities considered for graph construction. ClaimSchema does
 * NOT bound people[]/entities[] length, and all-pairs edges are O(n^2): an
 * attacker-supplied 1000-name array would mint 1000 pages + ~1e6 edges in one
 * tx. We take the first N (input order: people before companies) for the graph;
 * the fact row itself still records every name in its `context` string, so
 * nothing the client sent is lost — only the GRAPH fan-out is bounded. N=32
 * caps edges at 32*31 = 992 per fact, comfortably batchable.
 */
const MAX_ENTITIES_PER_FACT = 32;

/**
 * The boilerplate line that marks a page body as an un-materialized stub. Search
 * ranking (hybrid.ts `isStubChunk`) keys on this exact string to demote stubs
 * below real fact-bearing content, and `isConstructOwnedPage` uses it as a
 * forward-safe ownership signal. Keep the two in sync — changing it here means
 * changing the detector there.
 */
export const STUB_MARKER = '*Stub page. Created from a saved fact.*';

/** The minimal graph-anchor body for an entity with no facts of its own yet. */
function stubBody(name: string, label: string): string {
  return `# ${name}\n\n**Type:** ${label}\n\n## Summary\n\n${STUB_MARKER}\n\n## Timeline\n`;
}

/** Human label for a page `type`. 'person'/'company' get the canonical casing. */
function typeLabel(type: string): string {
  if (type === 'person') return 'Person';
  if (type === 'company') return 'Company';
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Entity';
}

/**
 * Embed a batch of chunk texts, INJECTED by the caller so this module stays
 * gateway-free (the FLAG-C / red-team isolation proof — no AI-gateway import
 * here). Returns one vector per text, or null for any that failed. save_facts
 * supplies the ZeroEntropy zembed-1 batch embed when the embedding lane is
 * configured; omitted → chunks land NULL-embedded (keyword-searchable via the
 * search_vector trigger, vector arm filled later by `embed --stale`).
 */
export type EmbedChunksFn = (texts: string[]) => Promise<Array<Float32Array | null>>;

export interface ConstructInput {
  /** Surface forms of people co-mentioned in the claim (→ people/ pages). */
  people?: string[];
  /** Surface forms of non-person entities (companies, orgs) (→ companies/ pages). */
  entities?: string[];
  /** Surface forms that were listed as people anywhere in the surrounding batch. */
  personSurfaceHints?: string[];
  /** The fact's sanitized claim text, stamped as each edge's context. */
  claimText: string;
}

export interface ConstructResult {
  /** Entity stub pages newly created this call (pre-existing pages are reused, not re-created). */
  pagesCreated: number;
  /**
   * content_chunks rows written for newly-created stubs this call, so the
   * entities are reachable by `search_brain`/`query`. 0 when no new stub was
   * minted (existing pages keep their own chunks; we never re-chunk them).
   * Chunks land NULL-embedding; `embed --stale` fills the vector arm.
   */
  chunksCreated: number;
  /** Co-occurrence edge rows newly inserted (ON CONFLICT DO NOTHING → 0 on resend). */
  edgesCreated: number;
}

/**
 * Build the entity-page + co-occurrence-edge graph for ONE inserted fact.
 *
 * Must be called inside the caller's withSourceScope tx (so pages and edges land
 * under the tenant role, RLS-confined to `sourceId`, and the stubs are visible to
 * the edge batch's same-tx JOIN). `engine` is the tx-scoped engine handed to the
 * save_facts handler.
 */
export async function constructGraphFromClaim(
  engine: BrainEngine,
  sourceId: string,
  input: ConstructInput,
): Promise<ConstructResult> {
  // 1. Ordered (name, type) refs — people first, then companies, matching the
  //    cap's documented truncation order. Person membership wins across the
  //    surrounding batch: if a surface ever appeared in people[], later
  //    entities[] mentions of the same surface are still people.
  const personSurfaces = new Set<string>();
  for (const name of input.personSurfaceHints ?? []) {
    const key = surfaceKey(name);
    if (key) personSurfaces.add(key);
  }
  for (const name of input.people ?? []) {
    const key = surfaceKey(name);
    if (key) personSurfaces.add(key);
  }
  const refs: Array<{ name: string; type: 'person' | 'company' }> = [];
  for (const name of input.people ?? []) refs.push({ name, type: 'person' });
  for (const name of input.entities ?? []) {
    refs.push({ name, type: personSurfaces.has(surfaceKey(name)) ? 'person' : 'company' });
  }
  if (refs.length === 0) return { pagesCreated: 0, chunksCreated: 0, edgesCreated: 0 };

  // 2. Each ref → canonical slug; ensure a stub page exists (create only when
  //    absent — never clobber an already-enriched page). Dedup slugs preserving
  //    first-seen order (a claim may repeat a name, or "Acme"/"acme" collapse to
  //    one slug) so the all-pairs edge build below never self-links a node. Cap
  //    the distinct-entity count to bound the O(n^2) edge fan-out. `slugs`
  //    carries EVERY resolved entity (created or reused) — edges connect them all.
  const slugs: string[] = [];
  const seen = new Set<string>();
  let pagesCreated = 0;
  let chunksCreated = 0;
  for (const ref of refs) {
    if (slugs.length >= MAX_ENTITIES_PER_FACT) break;
    const resolved = await resolveConstructSlug(engine, sourceId, ref.name, ref.type);
    if (resolved === null) continue; // name slugified to an empty body — skip
    const { slug, shouldCreateStub } = resolved;
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (shouldCreateStub) {
      const stub = await ensureStub(engine, sourceId, slug, ref.name, ref.type);
      if (stub.pageCreated) pagesCreated += 1;
      chunksCreated += stub.chunksCreated;
    }
    slugs.push(slug);
  }

  // 3. Bidirectional co-occurrence edges across every distinct pair. A single
  //    entity in the claim produces a page but no edge (nothing to connect).
  if (slugs.length < 2) return { pagesCreated, chunksCreated, edgesCreated: 0 };
  const context = input.claimText.slice(0, 500);
  const links: LinkBatchInput[] = [];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      links.push(edge(slugs[i], slugs[j], context, sourceId));
      links.push(edge(slugs[j], slugs[i], context, sourceId));
    }
  }
  const edgesCreated = await engine.addLinksBatch(links); // gbrain-allow-direct-insert: deterministic save_facts graph construct — co-occurrence edges from a client-extracted fact; low-level batch insert inside the withSourceScope tx, NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
  return { pagesCreated, chunksCreated, edgesCreated };
}

/**
 * Resolve an entity name for graph construction.
 *
 * Exact / fuzzy / prefix hits are existing pages, so the construct reuses them
 * without touching the page body. Only the resolver's fallback_slugify branch
 * means "new entity"; at that point the construct mints its typed graph-stub
 * slug (`people/...` or `companies/...`) and creates it via ensureStub.
 */
async function resolveConstructSlug(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  type: 'person' | 'company',
): Promise<{ slug: string; shouldCreateStub: boolean } | null> {
  const resolved = await resolveEntitySlugWithSource(engine, sourceId, name, {
    fuzzyThreshold: ENTITY_RESOLUTION_FUZZY_THRESHOLD,
  });
  if (resolved === null) return null;
  if (resolved.source !== 'fallback_slugify') {
    return { slug: resolved.slug, shouldCreateStub: false };
  }

  const slug = fallbackStubSlug(name, type);
  return slug ? { slug, shouldCreateStub: true } : null;
}

/**
 * Typed fallback slug for a new entity name, or null if the name has no slug body.
 * `slugifyEntity` always returns `<prefix>/<body>`; a body-less result
 * (e.g. a punctuation-only name → "people/") is a junk page we refuse to mint.
 */
function fallbackStubSlug(name: string, type: 'person' | 'company'): string | null {
  const slug = slugifyEntity(name, type);
  const body = slug.slice(slug.indexOf('/') + 1);
  return body ? slug : null;
}

function surfaceKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Ensure a stub page exists at the canonical slug. Returns true if it CREATED
 * one, false if a page was already there.
 *
 * Check-then-create, NOT a blind upsert: putPage is ON CONFLICT (source_id,
 * slug) DO UPDATE, which OVERWRITES title + compiled_truth. A blind putPage on
 * every mention would clobber a page that some other path (e.g. a customer-plane
 * enrich step) enriched between facts. The exact, source-scoped getPage gate
 * means a later mention of an existing entity only wires edges — it never
 * rewrites the page.
 *
 * Deliberately minimal content: a graph anchor, not a profile.
 *
 * Also writes the stub's content_chunks so the entity is reachable by
 * `search_brain`/`query` (see the SEARCHABILITY note in the module header).
 * Returns whether a page was created and how many chunks were written (0 when
 * the page already existed — we never re-chunk an existing page here).
 */
async function ensureStub(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  name: string,
  type: 'person' | 'company',
): Promise<{ pageCreated: boolean; chunksCreated: number }> {
  // Source-scoped existence check (hides soft-deleted by default). On Postgres
  // this is also RLS-confined to the tenant; here it keeps PGLite (no RLS)
  // honest about which source owns the page.
  if (await engine.getPage(slug, { sourceId })) return { pageCreated: false, chunksCreated: 0 };
  const compiledTruth = stubBody(name, typeLabel(type));
  await engine.putPage( // gbrain-allow-direct-insert: deterministic save_facts graph construct — entity stub from a client-extracted fact; low-level upsert, NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
    slug,
    {
      title: name,
      type,
      compiled_truth: compiledTruth,
      timeline: '',
      // Stamp the current chunker version so the stub is recorded as chunked at
      // v${MARKDOWN_CHUNKER_VERSION} (matching authored pages) and a later
      // `reindex` sweep does not treat it as stale. Mirrors import-file.ts:766.
      chunker_version: MARKDOWN_CHUNKER_VERSION,
      // Raw object — putPage passes it through sql.json(); never JSON.stringify
      // into a ::jsonb cast (postgres.js double-encodes; the project invariant).
      frontmatter: { source: 'mcp:save_facts' },
    },
    { sourceId },
  );
  const chunksCreated = await writeStubChunks(engine, sourceId, slug, compiledTruth);
  return { pageCreated: true, chunksCreated };
}

/**
 * Chunk a freshly-created stub's compiled_truth into content_chunks so it is
 * reachable by hybrid search. Same chunkText→upsertChunks pair the authored
 * put_page path runs inside its transaction (import-file.ts:643/816), called
 * here on the tenant-plane withSourceScope tx engine.
 *
 * FLAG-C-safe by construction: `chunkText` is a pure local splitter (no config,
 * no AI gateway) and `upsertChunks` is plain SQL (SELECT page id → DELETE →
 * INSERT) — the SAME batchRetry-wrapped low-level write construct already uses
 * for `addLinksBatch`, with no getConfig anywhere on the path. Chunks land with
 * NO embedding: `chunk_search_vector_trigger` makes them keyword-searchable at
 * once, and the existing `embed --stale` pass fills the vector arm later (the
 * deferred-embed contract `reindex` relies on). Keeps the module's "0 embedding
 * calls" cost contract intact.
 */
async function writeStubChunks(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  compiledTruth: string,
): Promise<number> {
  const chunks: ChunkInput[] = chunkText(compiledTruth).map((c, i) => ({
    chunk_index: i,
    chunk_text: c.text,
    chunk_source: 'compiled_truth',
  }));
  if (chunks.length === 0) return 0;
  await engine.upsertChunks(slug, chunks, { sourceId }); // gbrain-allow-direct-insert: deterministic save_facts graph construct — stub chunks from a client-extracted fact; low-level upsert (NULL embedding, trigger-built search_vector), NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
  return chunks.length;
}

/**
 * Deterministic entity body from the entity's OWN active facts — the search_brain
 * materialization (CC packet 2026-06-18). LLM-FREE: pure string assembly, no chat
 * gateway (which the tenant plane does not have). Keeps the `# <title>` /
 * `**Type:**` header so entity-name title matching still fires, and lists each
 * distinct fact under a `## Facts` section so the chunk arm of hybrid search
 * retrieves real fact substance instead of the stub skeleton. With no facts it
 * returns the stub body unchanged, so a fact-less co-mention page stays a stub.
 *
 * Append-stable: `listFactsByEntity` returns newest-first, so we render
 * oldest-first — an existing fact keeps its line position as new facts arrive,
 * which keeps the body (and thus the content_hash / chunk set) stable across
 * re-materializations that didn't actually change the fact set.
 */
export function compileEntityBody(
  title: string,
  type: string,
  facts: Array<Pick<FactRow, 'fact'>>,
): string {
  const label = typeLabel(type);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (let i = facts.length - 1; i >= 0; i--) {
    const text = facts[i].fact.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(`- ${text}`);
  }
  if (lines.length === 0) return stubBody(title, label);
  return `# ${title}\n\n**Type:** ${label}\n\n## Facts\n\n${lines.join('\n')}\n\n## Timeline\n`;
}

/**
 * Is this page safe for save_facts to rebuild from facts? YES when save_facts
 * created it (`frontmatter.source === 'mcp:save_facts'`) or its body still bears
 * the stub marker (legacy stubs + forward-safe). Authored / enriched pages
 * (operator-plane synthesize, imported markdown) have NEITHER, so we NEVER
 * clobber a real body with a deterministic facts compile.
 */
function isConstructOwnedPage(page: Page): boolean {
  const source = (page.frontmatter as { source?: unknown } | null | undefined)?.source;
  if (source === 'mcp:save_facts') return true;
  return page.compiled_truth.includes(STUB_MARKER);
}

/**
 * Rebuild each entity page's `compiled_truth` from its own active facts and
 * re-chunk it, so `search_brain` (hybrid search over content_chunks) retrieves
 * the entity's real fact substance — the search_brain-empty root cause was that
 * these bodies were stub skeletons (see the module SEARCHABILITY header).
 *
 * Runs INSIDE the caller's withSourceScope tx (same-tx visibility of the facts
 * just inserted; RLS-confined to `sourceId` under the gbrain_tenant role). Pure
 * SQL + a local chunk split + an OPTIONAL injected embed — no getConfig, no
 * put_page op, no chat model. Idempotent: an unchanged fact set produces an
 * identical body and is skipped (no rewrite, no re-chunk).
 *
 * - never clobbers authored/enriched pages (isConstructOwnedPage gate);
 * - leaves a fact-less page as a stub (nothing to materialize);
 * - chunk embedding is best-effort via `opts.embedChunks` — on omission/failure
 *   chunks land NULL-embedded (keyword-searchable at once; `embed --stale` fills
 *   the vector arm later), so an embed hiccup never breaks the save.
 * - every rewrite snapshots the page's PRE-update state — enforced INSIDE
 *   putPage since VT-6 (engine audit 2026-07-17), the same engine-level
 *   contract every write path now gets. As-of reconstruction (worker
 *   pro-time-travel `open_note_as_of`) reads the version chain as "a
 *   snapshot at T holds the content that stood until T"; before 4a33b46,
 *   the materialize was a NON-versioning rewrite, so every save_facts batch
 *   moved updated_at with no snapshot and permanently poisoned time-travel
 *   for exactly the pages save_facts keeps current.
 *   Pages already rewritten versionlessly can't be back-filled (the pre-state
 *   is gone) — the first post-fix rewrite banks whatever stands now, so the
 *   chain is whole from that point forward and the older gap stays honestly
 *   disclosed by the reader (updated_at moved, no covering snapshot).
 */
export async function materializeEntityPages(
  engine: BrainEngine,
  sourceId: string,
  entitySlugs: Iterable<string>,
  opts?: { embedChunks?: EmbedChunksFn; embeddingSignature?: string | null },
): Promise<{ pagesMaterialized: number; chunksWritten: number }> {
  // Phase 1 — resolve every entity that needs a rebuild (gate + idempotency
  // skip), computing its new body + chunks. No writes yet.
  const pending: Array<{ slug: string; page: Page; chunks: ChunkInput[] }> = [];
  const done = new Set<string>();
  for (const slug of entitySlugs) {
    if (!slug || done.has(slug)) continue;
    done.add(slug);

    const page = await engine.getPage(slug, { sourceId });
    if (!page) continue;                        // fact anchored to a slug with no page — the facts arm still serves it
    if (!isConstructOwnedPage(page)) continue;  // authored/enriched body — never clobber

    const facts = await engine.listFactsByEntity(sourceId, slug, { activeOnly: true, limit: 100 });

    // FS-8 (RED-B, PACKET ENGINE-PREP 2026-07-20): do NOT short-circuit the
    // zero-active-facts case. A page whose last active fact was just expired
    // (forget / cross-subject supersede) must not keep its stale materialized
    // body — the chunk arm of find_in_record (searchKeyword/searchVector over
    // content_chunks) has no expired_at filter and no join to facts, so the
    // forgotten value would keep surfacing via meaning search. compileEntityBody
    // returns a STUB body for an empty set; the idempotency check below skips a
    // page that is already a stub, and the empty `chunks` array makes
    // upsertChunks DELETE the page's content chunks — reverting it to a
    // never-materialized stub. The isConstructOwnedPage gate above already
    // protects authored / enriched pages from being blanked. A non-empty fact
    // set re-chunks the compiled body exactly as before.
    const body = compileEntityBody(page.title, page.type, facts);
    if (body === page.compiled_truth) continue; // idempotent: identical body, skip rewrite + re-chunk

    const chunks: ChunkInput[] = facts.length === 0
      ? [] // zero active facts → blank to stub + drop chunks so the value stops surfacing (RED-B)
      : chunkText(body).map((c, i) => ({
          chunk_index: i,
          chunk_text: c.text,
          chunk_source: 'compiled_truth',
        }));
    pending.push({ slug, page: { ...page, compiled_truth: body }, chunks });
  }
  if (pending.length === 0) return { pagesMaterialized: 0, chunksWritten: 0 };

  // Phase 2 — embed ALL new chunks in ONE batch (best-effort), so the
  // withSourceScope tx holds open across a single network round-trip, not one
  // per entity. On any failure chunks land NULL-embedded: keyword-searchable at
  // once via the search_vector trigger, `embed --stale` fills the vector arm.
  if (opts?.embedChunks) {
    const flat = pending.flatMap(p => p.chunks);
    if (flat.length > 0) {
      try {
        const embeddings = await opts.embedChunks(flat.map(c => c.chunk_text));
        for (let i = 0; i < flat.length; i++) {
          const vec = embeddings[i];
          if (vec) flat[i].embedding = vec;
        }
      } catch {
        // Embedding lane hiccup — degrade to NULL-embedded chunks (see above).
      }
    }
  }

  // Phase 3 — write each rebuilt page + its chunks.
  let chunksWritten = 0;
  for (const { slug, page, chunks } of pending) {
    // Version contract (a version row at T = the content that stood until T,
    // which as-of reconstruction depends on): now enforced INSIDE putPage
    // itself (VT-6, engine audit 2026-07-17) — the upsert banks the
    // pre-update state atomically whenever the body/frontmatter actually
    // change. The explicit createVersion that stood here (4a33b46) would
    // double-mint. Phase 1 guarantees only body-changed pages reach here,
    // so a snapshot fires for every write below, exactly as before; RLS
    // posture is unchanged (gbrain_tenant holds page_versions DML +
    // sequence USAGE per b7-role.sql, and the snapshot's feeding SELECT is
    // source-scoped inside putPage).
    await engine.putPage( // gbrain-allow-direct-insert: deterministic save_facts materialize — entity body rebuilt from its own active facts; low-level upsert, NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
      slug,
      {
        title: page.title,
        type: page.type,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline ?? '',
        chunker_version: MARKDOWN_CHUNKER_VERSION,
        // Stamp the durable ownership marker so a marker-only-qualified page (a
        // legacy stub whose body loses the STUB_MARKER after this rewrite) stays
        // construct-owned and keeps converging on later batches.
        frontmatter: { ...page.frontmatter, source: 'mcp:save_facts' },
      },
      { sourceId },
    );
    await engine.upsertChunks(slug, chunks, { sourceId }); // gbrain-allow-direct-insert: deterministic save_facts materialize — fact-substance chunks replace the stub chunk; low-level upsert, NOT the put_page op
    if (opts?.embeddingSignature && chunks.some(c => c.embedding)) {
      await engine.setPageEmbeddingSignature(slug, { sourceId, signature: opts.embeddingSignature });
    }
    chunksWritten += chunks.length;
  }
  return { pagesMaterialized: pending.length, chunksWritten };
}

/**
 * FS-8 (RED-B, PACKET ENGINE-PREP 2026-07-20): re-materialize ONE entity page
 * after its fact set changed on the EXPIRE path (forget / supersede), so a
 * corrected-away or forgotten value stops surfacing via the chunk arm of
 * find_in_record. Rebuilds the page from its remaining active facts, or blanks
 * it to a stub + drops its chunks when none remain (materializeEntityPages
 * handles both). Standalone twin of the post-loop materialize save_facts runs:
 * it sets up the SAME best-effort embedding lane (isAvailable('embedding') is an
 * in-memory gateway read — no DB config, FLAG-C-safe on the tenant plane) and
 * runs inside engine.transaction (a SAVEPOINT when nested in the tenant tx, a
 * real tx at top level). CONTAINED: a derived-layer rebuild failure is swallowed
 * so it can NEVER undo the primary expire/forget. Idempotent + LLM-free.
 */
export async function rematerializeEntityAfterExpire(
  engine: BrainEngine,
  sourceId: string,
  entitySlug: string,
): Promise<void> {
  if (!entitySlug) return;
  const embeddingsOn = isAvailable('embedding');
  const embedChunks = embeddingsOn ? (texts: string[]) => embedBatch(texts) : undefined;
  const embeddingSignature = embeddingsOn ? currentEmbeddingSignature() : null;
  try {
    await engine.transaction((txEngine) =>
      materializeEntityPages(txEngine, sourceId, new Set([entitySlug]), {
        embedChunks,
        embeddingSignature,
      }),
    );
  } catch (err) {
    console.error(
      `[facts:rematerialize] skipped for ${entitySlug}, expire already applied (rematerialize writes rolled back to their own savepoint/tx): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * F1-1 (v2 remediation, adversarial review 2026-07-21): delete the
 * construct-owned co_occurrence edges minted from an expired claim, so the
 * forgotten/corrected-away value stops surfacing verbatim on the GRAPH read
 * path (get_links / traverse_graph). constructGraphFromClaim stamps
 * `context = claimText.slice(0, 500)` into every edge it mints, so the expired
 * claim's edges are exactly the co_occurrence/'manual' edges whose context
 * equals that slice — deleting by (source, type, link_source, context) removes
 * BOTH directions of every pair from that claim and touches nothing else: an
 * edge minted from a DIFFERENT still-active claim carries that claim's own
 * context and survives (identical text would have deduped to the same fact).
 *
 * CONTAINED exactly like rematerializeEntityAfterExpire: runs in its own
 * engine.transaction (a SAVEPOINT when nested inside the tenant tx, a real tx
 * at top level) with the error swallowed, so a derived-layer cleanup failure
 * can NEVER undo or block the primary expire/forget. Pure SQL — no config, no
 * LLM, no embedding; RLS-confined via the pages join under the tenant role.
 */
export async function cleanupCoOccurrenceEdgesForExpiredClaim(
  engine: BrainEngine,
  sourceId: string,
  claimText: string,
): Promise<void> {
  const context = claimText.slice(0, 500);
  if (!context) return;
  try {
    await engine.transaction(async (txEngine) => {
      await txEngine.executeRaw(
        `DELETE FROM links l
          USING pages f
          WHERE l.from_page_id = f.id
            AND f.source_id = $1
            AND l.link_type = '${LINK_TYPE}'
            AND l.link_source = '${LINK_SOURCE}'
            AND l.context = $2`,
        [sourceId, context],
      );
    });
  } catch (err) {
    console.error(
      `[facts:edge-cleanup] skipped, expire already applied (edge deletes rolled back to their own savepoint/tx): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** One directed co-occurrence edge, source-qualified on both endpoints. */
function edge(from: string, to: string, context: string, sourceId: string): LinkBatchInput {
  return {
    from_slug: from,
    to_slug: to,
    link_type: LINK_TYPE,
    context,
    link_source: LINK_SOURCE,
    from_source_id: sourceId,
    to_source_id: sourceId,
  };
}
