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
 * COST — per fact: 0 chat-model calls, 0 embedding calls. Pure SQL: N slug
 * string-ops + ≤N page upserts + 1 batched edge insert. Passes the zero-LLM-
 * per-fact economic gate by construction (the customer's own model already paid
 * for the cognition that produced the arrays; turning them into a graph is DB
 * work). This module imports nothing from the AI gateway.
 *
 * TENANT-PLANE DISCIPLINE (CC packet "where the real care goes"):
 *   - LOW-LEVEL direct writes only — `engine.putPage` / `engine.addLinksBatch`,
 *     NOT the `put_page` OP. The op's post-write hooks (auto_link, write-through
 *     render) are the FLAG-C config-read / embedding surface the b7 series keeps
 *     OFF the tenant plane; these engine methods are plain upserts/inserts.
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

import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { slugifyEntity } from '../enrichment-service.ts';

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
  if (refs.length === 0) return { pagesCreated: 0, edgesCreated: 0 };

  // 2. Each ref → canonical slug; ensure a stub page exists (create only when
  //    absent — never clobber an already-enriched page). Dedup slugs preserving
  //    first-seen order (a claim may repeat a name, or "Acme"/"acme" collapse to
  //    one slug) so the all-pairs edge build below never self-links a node. Cap
  //    the distinct-entity count to bound the O(n^2) edge fan-out. `slugs`
  //    carries EVERY resolved entity (created or reused) — edges connect them all.
  const slugs: string[] = [];
  const seen = new Set<string>();
  let pagesCreated = 0;
  for (const ref of refs) {
    if (slugs.length >= MAX_ENTITIES_PER_FACT) break;
    const resolved = await resolveConstructSlug(engine, sourceId, ref.name, ref.type);
    if (resolved === null) continue; // name slugified to an empty body — skip
    const { slug, shouldCreateStub } = resolved;
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (shouldCreateStub && await ensureStub(engine, sourceId, slug, ref.name, ref.type)) pagesCreated += 1;
    slugs.push(slug);
  }

  // 3. Bidirectional co-occurrence edges across every distinct pair. A single
  //    entity in the claim produces a page but no edge (nothing to connect).
  if (slugs.length < 2) return { pagesCreated, edgesCreated: 0 };
  const context = input.claimText.slice(0, 500);
  const links: LinkBatchInput[] = [];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      links.push(edge(slugs[i], slugs[j], context, sourceId));
      links.push(edge(slugs[j], slugs[i], context, sourceId));
    }
  }
  const edgesCreated = await engine.addLinksBatch(links); // gbrain-allow-direct-insert: deterministic save_facts graph construct — co-occurrence edges from a client-extracted fact; low-level batch insert inside the withSourceScope tx, NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
  return { pagesCreated, edgesCreated };
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
 */
async function ensureStub(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  name: string,
  type: 'person' | 'company',
): Promise<boolean> {
  // Source-scoped existence check (hides soft-deleted by default). On Postgres
  // this is also RLS-confined to the tenant; here it keeps PGLite (no RLS)
  // honest about which source owns the page.
  if (await engine.getPage(slug, { sourceId })) return false;
  const label = type === 'person' ? 'Person' : 'Company';
  await engine.putPage( // gbrain-allow-direct-insert: deterministic save_facts graph construct — entity stub from a client-extracted fact; low-level upsert, NOT the put_page op (no FLAG-C post-write hooks on the tenant plane)
    slug,
    {
      title: name,
      type,
      compiled_truth: `# ${name}\n\n**Type:** ${label}\n\n## Summary\n\n*Stub page. Created from a saved fact.*\n\n## Timeline\n`,
      timeline: '',
      // Raw object — putPage passes it through sql.json(); never JSON.stringify
      // into a ::jsonb cast (postgres.js double-encodes; the project invariant).
      frontmatter: { source: 'mcp:save_facts' },
    },
    { sourceId },
  );
  return true;
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
