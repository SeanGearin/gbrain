/**
 * v0.32.2: parser/renderer for fenced facts tables.
 *
 * The `## Facts` fence on an entity page is the system-of-record for facts
 * about that entity. The `facts` DB table is a derived index reconciled by
 * the new `extract_facts` cycle phase. This module is the boundary between
 * the markdown and the DB.
 *
 * Structural mirror of `src/core/takes-fence.ts`. Same fence-shape
 * primitives, same strict-canonical-lenient-hand-edit posture, same
 * append-only row_num contract. Different column set:
 *
 *   ## Facts
 *
 *   <!--- gbrain:facts:begin -->
 *   | # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
 *   |---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
 *   | 1 | Founded Acme in 2017             | fact       | 1.0  | world   | high   | 2017-01-01 |            | linkedin       |                                    |
 *   | 2 | Prefers async over meetings      | preference | 0.85 | private | medium | 2026-04-29 |            | OH 2026-04-29  |                                    |
 *   | 3 | ~~Will hit $10M ARR by Q4~~      | commitment | 0.55 | world   | medium | 2026-06-01 | 2026-12-31 | bo call        | superseded by #4                   |
 *   | 4 | ~~Used to live in Tokyo~~        | fact       | 0.9  | private | low    | 2018-01-01 | 2026-05-10 | inferred       | forgotten: user asked to remove    |
 *   <!--- gbrain:facts:end -->
 *
 * 10 data columns + the leading `#` row-number column = 11 cells per row
 * including the leading and trailing pipes.
 *
 * Strikethrough parse contract (resolves Codex R2-#3 forget-as-fence):
 *   - `~~claim~~` + `context: superseded by #N` → active=false, supersededBy=N
 *   - `~~claim~~` + `context: forgotten: <reason>` → active=false, forgotten=true
 *   - `~~claim~~` + anything else in context → active=false, both flags null
 *
 * The semantic layer (commit 3's `extract-from-fence.ts`) maps `forgotten`
 * to `valid_until = today` AND (v0.42.24) derives `expired_at` directly —
 * there is no DB-side `valid_until → expired_at` rule; the mapper is the
 * only place inactive fence rows acquire their expiry state.
 *
 * Both fences share row-level helpers via `./fence-shared.ts` — see that
 * module for `parseRowCells`, `isSeparatorRow`, `stripStrikethrough`, and
 * `escapeFenceCell`. Domain-specific parsing (column ordering, kind/
 * visibility/notability enums, the strikethrough-context distinction)
 * lives in this file.
 */

import {
  parseRowCells,
  isSeparatorRow,
  stripStrikethrough,
  parseStringCell,
  escapeFenceCell,
} from './fence-shared.ts';

// HTML-comment fence markers — verbatim per spec. Same shape as the takes
// fence markers so anyone who's seen one immediately recognizes the other.
export const FACTS_FENCE_BEGIN = '<!--- gbrain:facts:begin -->';
export const FACTS_FENCE_END   = '<!--- gbrain:facts:end -->';

// Mirror src/core/engine.ts FactKind. Re-declared (not imported) because
// the fence parser has zero engine dependencies — it must run in pure-
// markdown contexts (the chunker strip, the CI invariant check) where
// importing engine.ts pulls a large DB-shaped transitive graph.
export type FactKind = 'event' | 'preference' | 'commitment' | 'belief' | 'fact';

// Mirror src/core/engine.ts FactVisibility ('private' | 'world'). Binary
// gate per the existing takes D21 contract — drives the chunker strip
// (Layer A) and the get_page response strip (Layer B).
export type FactVisibility = 'private' | 'world';

export type FactNotability = 'high' | 'medium' | 'low';

const KIND_VALUES: ReadonlySet<string> = new Set([
  'event', 'preference', 'commitment', 'belief', 'fact',
]);
const VISIBILITY_VALUES: ReadonlySet<string> = new Set(['private', 'world']);
const NOTABILITY_VALUES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/** Parsed shape of a single fence row. */
export interface ParsedFact {
  rowNum: number;
  claim: string;          // strikethrough markers stripped on parse
  kind: FactKind;
  confidence: number;     // 0..1 (clamp/normalize happens in the engine layer)
  visibility: FactVisibility;
  notability: FactNotability;
  validFrom?: string;     // ISO date 'YYYY-MM-DD' (or empty)
  validUntil?: string;
  source?: string;
  context?: string;
  active: boolean;        // false when claim was wrapped in `~~ ~~`
  /**
   * v0.32.2 strikethrough semantics. Both are mutually exclusive with `active=true`.
   *   - `supersededBy` set: the row was superseded by another fence row;
   *     `context` matches `/superseded by #(\d+)/i`.
   *   - `forgotten` true: the user invoked `gbrain forget` on this row;
   *     `context` matches `/^forgotten:/i`.
   * When neither is set but `active=false`, the row is "inactive for
   * unrecognized reason" — the parser preserves it (markdown source-of-
   * truth contract) but downstream `extract-from-fence` treats it like
   * `forgotten` for DB-derivation purposes.
   */
  supersededBy?: number;
  forgotten?: boolean;
  /**
   * v0.42.24 (fence-resurrection class): DB-id supersession pointer.
   * Set when `context` matches `/superseded by fact #(\d+)/i` — written by
   * `facts/supersede.ts` when a B2 `save_facts` supersede strikes a
   * fence-backed target. Distinct from `supersededBy` (which points at
   * another FENCE ROW by row_num): the superseding fact here is a DB-only
   * row (NULL source_markdown_slug) whose id is stable across rebuilds, so
   * the id-pointer round-trips. The extract mapper re-derives
   * `facts.superseded_by` + `expired_at` from this on every reconcile,
   * which is what makes a B2 supersession survive `gbrain rebuild`.
   */
  supersededByFactId?: number;
  /**
   * v0.35.4 typed-claim fields (D-CDX-5). Optional. When present, drives
   * `gbrain eval trajectory` + the `find_trajectory` MCP op chronological
   * regression detection. The fence layout widens from 10 to 14 columns
   * when any row in the table has a non-undefined typed field; otherwise
   * stays 10-cell for backward compat with existing fences.
   *
   *   - `claimMetric`: lowercase snake_case after normalization
   *     (`mrr`, `arr`, `team_size`, …). Free-text labels accepted; the
   *     parser does not enforce the seed-map allow-list.
   *   - `claimValue`: numeric, finite. Empty cell → undefined.
   *   - `claimUnit`: free-form unit string (`USD`, `people`, `pct`, …).
   *   - `claimPeriod`: free-form period string (`monthly`, `annual`, …)
   *     or undefined for non-periodic metrics.
   */
  claimMetric?: string;
  claimValue?: number;
  claimUnit?: string;
  claimPeriod?: string;
}

export interface FactsFenceParseResult {
  facts: ParsedFact[];
  warnings: string[];
}

function parseConfidenceCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * v0.35.4 — parse a free-form numeric cell for typed-claim values.
 * Empty / non-numeric → undefined (caller decides whether to drop or warn).
 * Tolerates plain numbers and standard scientific notation. Locale-dependent
 * thousand separators (`,`) are stripped so `50,000` parses to `50000`.
 */
function parseNumericCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(/,/g, '');
  const n = parseFloat(stripped);
  return Number.isFinite(n) ? n : undefined;
}

function parseSupersededByFromContext(context: string | undefined): number | undefined {
  if (!context) return undefined;
  const m = context.match(/superseded by #(\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * v0.42.24: DB-id supersession marker — `superseded by fact #<id>`.
 * Deliberately does NOT collide with the fence-row pointer above:
 * `superseded by #N` requires "by #", this requires "by fact #".
 */
function parseSupersededByFactIdFromContext(context: string | undefined): number | undefined {
  if (!context) return undefined;
  const m = context.match(/superseded by fact #(\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseForgottenFromContext(context: string | undefined): boolean {
  if (!context) return false;
  return /^forgotten\s*:/i.test(context.trim());
}

/**
 * Slice the body between the fence markers and parse the table.
 * Returns empty facts + empty warnings when no fence is present.
 *
 * Strict on canonical shape, lenient on hand-edits — malformed rows are
 * skipped with a warning, the rest of the table still parses. Callers
 * (extract-facts cycle phase, doctor) surface warnings as
 * `FACTS_TABLE_MALFORMED` sync-failures entries.
 */
export function parseFactsFence(body: string): FactsFenceParseResult {
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx   = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  const warnings: string[] = [];

  if (beginIdx === -1 && endIdx === -1) return { facts: [], warnings };
  if (beginIdx === -1 || endIdx === -1) {
    warnings.push('FACTS_FENCE_UNBALANCED: missing begin or end marker');
    return { facts: [], warnings };
  }
  if (endIdx < beginIdx) {
    warnings.push('FACTS_FENCE_UNBALANCED: end marker before begin');
    return { facts: [], warnings };
  }

  const inner = body.slice(beginIdx + FACTS_FENCE_BEGIN.length, endIdx);
  const lines = inner.split('\n');
  const facts: ParsedFact[] = [];
  let sawHeader = false;
  const seenRowNums = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;

    // Header row: cells include 'claim' and 'kind' (case-insensitive).
    if (!sawHeader) {
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('claim') && lower.includes('kind')) {
        sawHeader = true;
        continue;
      }
      warnings.push(`FACTS_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }

    // Separator row (just dashes/colons) — skip.
    if (isSeparatorRow(cells)) continue;

    // Expect 10 cells (legacy 10-cell fence) OR 14 cells (v0.35.4
    // typed-claim wide fence): row_num, claim, kind, confidence,
    // visibility, notability, valid_from, valid_until, source, context,
    // [claim_metric, claim_value, claim_unit, claim_period].
    // Tolerate 9 (missing trailing context cell) — markdown editors often
    // drop empty trailing cells.
    if (cells.length < 9) {
      warnings.push(`FACTS_TABLE_MALFORMED: only ${cells.length} cells in row "${line.trim()}"`);
      continue;
    }

    const [
      rowNumStr, claimRaw, kindRaw, confidenceRaw,
      visibilityRaw, notabilityRaw,
      validFromRaw, validUntilRaw,
      sourceRaw,
      contextRaw = '',
      claimMetricRaw = '',
      claimValueRaw = '',
      claimUnitRaw = '',
      claimPeriodRaw = '',
    ] = cells;

    const rowNum = parseInt(rowNumStr, 10);
    if (!Number.isFinite(rowNum) || rowNum <= 0) {
      warnings.push(`FACTS_TABLE_MALFORMED: invalid row_num "${rowNumStr}"`);
      continue;
    }
    if (seenRowNums.has(rowNum)) {
      warnings.push(`FACTS_ROW_NUM_COLLISION: duplicate row_num ${rowNum}`);
      continue;
    }
    seenRowNums.add(rowNum);

    const kind = kindRaw.trim().toLowerCase();
    if (!KIND_VALUES.has(kind)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown kind "${kindRaw}" (expected event|preference|commitment|belief|fact)`);
      continue;
    }

    const visibility = visibilityRaw.trim().toLowerCase();
    if (!VISIBILITY_VALUES.has(visibility)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown visibility "${visibilityRaw}" (expected private|world)`);
      continue;
    }

    const notability = notabilityRaw.trim().toLowerCase();
    if (!NOTABILITY_VALUES.has(notability)) {
      warnings.push(`FACTS_TABLE_MALFORMED: unknown notability "${notabilityRaw}" (expected high|medium|low)`);
      continue;
    }

    const confidence = parseConfidenceCell(confidenceRaw);
    if (confidence === undefined) {
      warnings.push(`FACTS_TABLE_MALFORMED: non-numeric confidence "${confidenceRaw}" in row ${rowNumStr}`);
      continue;
    }

    const { text: claimText, struck } = stripStrikethrough(claimRaw);
    const context = parseStringCell(contextRaw);
    const supersededBy = parseSupersededByFromContext(context);
    const supersededByFactId = parseSupersededByFactIdFromContext(context);
    const forgotten    = parseForgottenFromContext(context);

    facts.push({
      rowNum,
      claim: claimText,
      kind: kind as FactKind,
      confidence,
      visibility: visibility as FactVisibility,
      notability: notability as FactNotability,
      validFrom:  parseStringCell(validFromRaw),
      validUntil: parseStringCell(validUntilRaw),
      source:     parseStringCell(sourceRaw),
      context,
      active: !struck,
      supersededBy,
      supersededByFactId: struck ? supersededByFactId : undefined,
      forgotten: struck ? forgotten : false,
      // v0.35.4 — typed-claim fields, all optional.
      claimMetric: parseStringCell(claimMetricRaw),
      claimValue:  parseNumericCell(claimValueRaw),
      claimUnit:   parseStringCell(claimUnitRaw),
      claimPeriod: parseStringCell(claimPeriodRaw),
    });
  }

  if (!sawHeader && facts.length === 0 && lines.some(l => l.trim().startsWith('|'))) {
    warnings.push('FACTS_TABLE_MALFORMED: pipe-rows present but no recognizable header');
  }

  return { facts, warnings };
}

function formatConfidence(c: number): string {
  if (Number.isInteger(c)) return c.toFixed(1);
  return String(parseFloat(c.toFixed(2)));
}

/**
 * Render a facts array back to a fenced markdown table. Round-trip safe
 * with parseFactsFence. Same tight-column-padding posture as takes-fence
 * (one space per side, readable but not pretty-printed).
 *
 * Round-trip preservation is the safety net for the system-of-record
 * invariant: every CLI that re-renders a fence (forgetFactInFence,
 * upsertFactRow, the v0_32_2 migration backfill) must read existing rows
 * via parseFactsFence and pass them through renderFactsTable so existing
 * fence state survives unrelated edits to other rows.
 */
export function renderFactsTable(facts: ParsedFact[]): string {
  // v0.35.4 (D-CDX-5): widen to 14 cells when ANY row has a non-undefined
  // typed-claim field. Otherwise stay at the 10-cell legacy shape so
  // existing fences don't get widened on unrelated rewrites (no churn diff
  // noise).
  const anyTyped = facts.some(f =>
    f.claimMetric !== undefined ||
    f.claimValue  !== undefined ||
    f.claimUnit   !== undefined ||
    f.claimPeriod !== undefined,
  );
  const header = anyTyped ? FENCE_HEADER_WIDE : FENCE_HEADER_NARROW;
  const separator = anyTyped ? FENCE_SEPARATOR_WIDE : FENCE_SEPARATOR_NARROW;
  const rows = facts.map(f => renderFactRowLine(f, anyTyped));
  const inner = ['', header, separator, ...rows, ''].join('\n');
  return `${FACTS_FENCE_BEGIN}${inner}${FACTS_FENCE_END}`;
}

const FENCE_HEADER_NARROW = `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |`;
const FENCE_HEADER_WIDE = `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |`;
const FENCE_SEPARATOR_NARROW = `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|`;
const FENCE_SEPARATOR_WIDE = `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|`;

/**
 * Render a single fence row line. Extracted from renderFactsTable
 * (byte-identical output) so the line-preserving write paths
 * (`upsertFactRow`, `updateFactRowInFence`) can render ONE row without
 * re-rendering — and thereby lossily normalizing — the whole table.
 */
function renderFactRowLine(f: ParsedFact, wide: boolean): string {
  const claimCell = f.active ? f.claim : `~~${f.claim}~~`;
  const base = `| ${f.rowNum} | ${escapeFenceCell(claimCell)} | ${f.kind} | ${formatConfidence(f.confidence)} | ${f.visibility} | ${f.notability} | ${escapeFenceCell(f.validFrom ?? '')} | ${escapeFenceCell(f.validUntil ?? '')} | ${escapeFenceCell(f.source ?? '')} | ${escapeFenceCell(f.context ?? '')} |`;
  if (!wide) return base;
  const valueCell = f.claimValue === undefined ? '' : String(f.claimValue);
  return `${base} ${escapeFenceCell(f.claimMetric ?? '')} | ${escapeFenceCell(valueCell)} | ${escapeFenceCell(f.claimUnit ?? '')} | ${escapeFenceCell(f.claimPeriod ?? '')} |`;
}

/**
 * Classify the physical lines between the fence markers. Pure lexical
 * pass — no validation. Used by the line-preserving write paths to find
 * where a row lives (or where to append) WITHOUT dropping lines the
 * parser can't understand (hand-edit typos, prose comments, collision
 * rows). Erasing those on an unrelated write was the FE-2 lossy-rewrite
 * bug: the re-render replaced the whole fence with only the rows that
 * survived the lenient parse, permanently deleting everything else from
 * the system of record.
 */
interface FenceLineScan {
  /** Inner text between the markers, split on '\n' (verbatim, unparsed). */
  lines: string[];
  /** Index into `lines` of the header row, or -1 when no header found. */
  headerIdx: number;
  /** True when the header is the 14-cell typed-claim shape. */
  wide: boolean;
  /** Index into `lines` of the LAST pipe-shaped line (row/sep/header), or -1. */
  lastPipeIdx: number;
  /** Highest numeric first-cell across ALL pipe lines (incl. malformed rows). */
  maxRowNum: number;
  /** First line index (per row_num) for every numeric first-cell seen. */
  rowLineIdx: Map<number, number>;
}

function scanFenceLines(inner: string): FenceLineScan {
  const lines = inner.split('\n');
  let headerIdx = -1;
  let wide = false;
  let lastPipeIdx = -1;
  let maxRowNum = 0;
  const rowLineIdx = new Map<number, number>();

  for (let i = 0; i < lines.length; i++) {
    const cells = parseRowCells(lines[i]);
    if (!cells) continue;
    lastPipeIdx = i;
    if (headerIdx === -1) {
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('claim') && lower.includes('kind')) {
        headerIdx = i;
        wide = cells.length >= 14;
        continue;
      }
    }
    if (isSeparatorRow(cells)) continue;
    const n = parseInt(cells[0], 10);
    if (Number.isFinite(n) && n > 0) {
      if (n > maxRowNum) maxRowNum = n;
      if (!rowLineIdx.has(n)) rowLineIdx.set(n, i);
    }
  }
  return { lines, headerIdx, wide, lastPipeIdx, maxRowNum, rowLineIdx };
}

/**
 * True when `post` contains a warning that isn't accounted for in `pre`
 * (multiset semantics — a duplicated warning string counts per
 * occurrence). The line-preserving write paths' validate gate
 * (fence-write append, forget strike, supersede strike): pre-existing
 * fence damage is preserved rather than blocking, but an edit that
 * introduces NEW damage is refused (.tmp quarantined by the caller).
 */
export function introducesNewWarnings(pre: string[], post: string[]): boolean {
  const budget = new Map<string, number>();
  for (const w of pre) budget.set(w, (budget.get(w) ?? 0) + 1);
  for (const w of post) {
    const left = budget.get(w) ?? 0;
    if (left === 0) return true;
    budget.set(w, left - 1);
  }
  return false;
}

/**
 * Surgically replace ONE fence row line, preserving every other line
 * between the markers byte-for-byte (prose, malformed rows, collision
 * rows — everything the lenient parser would drop on a re-render).
 *
 * The row must round-trip through parseFactsFence (a hand-mangled target
 * row returns null so the caller can fall back with disclosure). The
 * mutated row renders at the physical line's own cell-width, so a
 * narrow row in a wide table (or vice versa) keeps its shape.
 *
 * Returns null when: no balanced fence, the row_num has no physical
 * line, or the parser could not produce a ParsedFact for it.
 */
export function updateFactRowInFence(
  body: string,
  rowNum: number,
  mutate: (f: ParsedFact) => ParsedFact,
): { body: string; before: ParsedFact; after: ParsedFact } | null {
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx   = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;

  const parsed = parseFactsFence(body);
  const before = parsed.facts.find(f => f.rowNum === rowNum);
  if (!before) return null;

  const innerStart = beginIdx + FACTS_FENCE_BEGIN.length;
  const inner = body.slice(innerStart, endIdx);
  const scan = scanFenceLines(inner);
  const lineIdx = scan.rowLineIdx.get(rowNum);
  if (lineIdx === undefined) return null;

  const lineCells = parseRowCells(scan.lines[lineIdx]);
  const lineWide = (lineCells?.length ?? 0) >= 14;
  const after = mutate({ ...before });
  // row_num is the row's identity — a mutation must not renumber it.
  after.rowNum = before.rowNum;

  const newLines = [...scan.lines];
  newLines[lineIdx] = renderFactRowLine(after, lineWide);
  const newInner = newLines.join('\n');
  return {
    body: body.slice(0, innerStart) + newInner + body.slice(endIdx),
    before,
    after,
  };
}

/**
 * Append a new fact row to the body. If a fenced facts table exists, the
 * row is added to the end of it. If not, a new `## Facts` section + fence
 * is created at the end of the body.
 *
 * Append-only — row_num is set to (max numeric first-cell across ALL
 * physical fence lines) + 1. The max scans physical lines rather than
 * parsed rows so a malformed row's number is never re-issued. Stable
 * forever, so cross-page refs like `<slug>#F<N>` keep pointing at the
 * same row.
 *
 * v0.42.24 (FE-2 lossy-rewrite fix): the append is LINE-PRESERVING. The
 * pre-fix implementation re-rendered the whole fence from the lenient
 * parse, which silently and permanently erased anything the parser
 * dropped (hand-edit typos, prose comments inside the markers, collision
 * rows) from the system-of-record file — and the atomic-write validate
 * gate could not catch it because the re-rendered body was already
 * clean. Now the new row is rendered as a single line and spliced in
 * after the last table line; every other byte between the markers is
 * preserved verbatim.
 *
 * v0.42.24 (FE-5 strikethrough-inversion fix): an ACTIVE claim whose
 * text is wrapped in `~~…~~` (pasted markdown strikethrough) would
 * render verbatim and then parse back as struck → the fact was born
 * expired with a success receipt. The fence format reserves whole-cell
 * strikethrough for inactive rows, so the wrap is stripped up front —
 * the stored claim equals what every later parse would deliver anyway.
 */
export function upsertFactRow(
  body: string,
  newRow: Omit<ParsedFact, 'rowNum' | 'active' | 'supersededBy' | 'forgotten'> & {
    rowNum?: number;
    active?: boolean;
  },
): { body: string; rowNum: number } {
  // FE-5: normalize an active claim that would round-trip as struck.
  let claim = newRow.claim;
  if (newRow.active !== false) {
    const { text, struck } = stripStrikethrough(claim);
    if (struck) claim = text;
  }

  const rowNeedsWide =
    newRow.claimMetric !== undefined ||
    newRow.claimValue  !== undefined ||
    newRow.claimUnit   !== undefined ||
    newRow.claimPeriod !== undefined;

  const makeRow = (rowNum: number): ParsedFact => ({
    rowNum,
    claim,
    kind: newRow.kind,
    confidence: newRow.confidence,
    visibility: newRow.visibility,
    notability: newRow.notability,
    validFrom: newRow.validFrom,
    validUntil: newRow.validUntil,
    source: newRow.source,
    context: newRow.context,
    active: newRow.active ?? true,
    // v0.35.4 — typed-claim pass-through. When undefined the renderer
    // stays at the 10-cell shape so unrelated edits don't widen the
    // fence.
    claimMetric: newRow.claimMetric,
    claimValue:  newRow.claimValue,
    claimUnit:   newRow.claimUnit,
    claimPeriod: newRow.claimPeriod,
  });

  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx   = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);

  if (beginIdx === -1 || endIdx === -1) {
    // No fence — create one at the end of the body (unchanged behavior).
    const row = makeRow(newRow.rowNum ?? 1);
    const newFence = renderFactsTable([row]);
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    return { body: `${body}${sep}## Facts\n\n${newFence}\n`, rowNum: row.rowNum };
  }

  const innerStart = beginIdx + FACTS_FENCE_BEGIN.length;
  const inner = body.slice(innerStart, endIdx);
  const scan = scanFenceLines(inner);
  const nextRowNum = newRow.rowNum ?? scan.maxRowNum + 1;
  const row = makeRow(nextRowNum);

  if (scan.headerIdx === -1) {
    // Fence markers exist but no recognizable table. When the inner
    // region is effectively empty, render a fresh table (nothing to
    // lose). When it carries content we can't classify, preserve it and
    // start the table after it.
    const table = renderFactsTable([row]);
    const tableInner = table.slice(FACTS_FENCE_BEGIN.length, table.length - FACTS_FENCE_END.length);
    const preserved = inner.trim().length === 0 ? '' : `${inner.replace(/\s*$/, '')}\n`;
    const newInner = `${preserved}${tableInner}`;
    return {
      body: body.slice(0, innerStart) + newInner + body.slice(endIdx),
      rowNum: nextRowNum,
    };
  }

  if (rowNeedsWide && !scan.wide) {
    // Widening rewrites every line, so it is only safe when the whole
    // fence is losslessly parseable (a lossy widen would erase whatever
    // the parser dropped — the exact FE-2 failure). No production write
    // path currently appends typed-claim rows via this function; refuse
    // loudly rather than lose data if one ever does against a fence
    // carrying unparseable content.
    const parsed = parseFactsFence(body);
    const classifiable = scan.lines.every((line, i) => {
      if (!line.trim()) return true;
      const cells = parseRowCells(line);
      if (!cells) return false; // prose inside the fence — would be erased
      if (i === scan.headerIdx) return true;
      if (isSeparatorRow(cells)) return true;
      const n = parseInt(cells[0], 10);
      return Number.isFinite(n) && parsed.facts.some(f => f.rowNum === n);
    });
    if (parsed.warnings.length > 0 || !classifiable) {
      throw new Error(
        `FACTS_FENCE_WIDEN_LOSSY: cannot widen a fence to the typed-claim shape while it carries unparseable content (${parsed.warnings.length} parse warning(s)); fix the fence or append without typed fields`,
      );
    }
    const newFence = renderFactsTable([...parsed.facts, row]);
    return {
      body: body.slice(0, beginIdx) + newFence + body.slice(endIdx + FACTS_FENCE_END.length),
      rowNum: nextRowNum,
    };
  }

  // Line-preserving append: splice the rendered row after the last
  // pipe-shaped line (always >= headerIdx here).
  const newLines = [...scan.lines];
  newLines.splice(scan.lastPipeIdx + 1, 0, renderFactRowLine(row, scan.wide));
  const newInner = newLines.join('\n');
  return {
    body: body.slice(0, innerStart) + newInner + body.slice(endIdx),
    rowNum: nextRowNum,
  };
}

export interface StripFactsFenceOpts {
  /**
   * Visibility values to KEEP in the rendered output. When omitted (the
   * default), the entire fence block is removed wholesale — matches
   * `stripTakesFence`'s contract and is what the chunker uses to keep
   * private text out of `content_chunks.chunk_text` (Codex R2-#1 P0 fix
   * + simpler than per-row filtering).
   *
   * When set to e.g. `['world']`, the function preserves the fence
   * structure but removes rows whose visibility is not in the allow-list.
   * Used by `get_page` for remote MCP callers to ship a useful response
   * (world facts visible) while keeping private rows on the boundary's
   * inside.
   */
  keepVisibility?: FactVisibility[];
}

/**
 * Strip facts content from the body for downstream consumers that must
 * not see (some or all of) it. Two modes:
 *
 *   1. No `keepVisibility` (or empty array): drop the entire fence
 *      block — same posture as `stripTakesFence`. Useful when a caller
 *      wants the body without ANY fence content (rare in practice; the
 *      privacy-boundary callers all want partial retention).
 *
 *   2. `keepVisibility: ['world']`: retain only world-visibility rows.
 *      The fence shape stays in the body so a re-importer can still
 *      round-trip the response; private rows are dropped at the row
 *      level. This is the mode BOTH the chunker (Codex R2-#1 — keeps
 *      world rows searchable, drops private text from
 *      `content_chunks.chunk_text` + embeddings + search) AND `get_page`
 *      over remote MCP (Codex Q5 — restricted callers see world rows
 *      only) use.
 *
 * The default whole-fence strip is the "deny-by-default" branch for any
 * caller that forgets to specify allowed visibility — a safer failure
 * mode at a privacy boundary than accidentally leaking.
 *
 * Returns the body unchanged when no fence is present.
 */
export function stripFactsFence(body: string, opts: StripFactsFenceOpts = {}): string {
  // Pages without a compiled body have nothing to strip. Guard so the privacy
  // strip is a safe no-op rather than crashing on `undefined.indexOf`.
  if (typeof body !== 'string') return body;
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  if (beginIdx === -1) return body;
  const endIdx = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  if (endIdx === -1) return body;

  // Whole-fence strip mode (chunker case).
  if (!opts.keepVisibility || opts.keepVisibility.length === 0) {
    return body.slice(0, beginIdx) + body.slice(endIdx + FACTS_FENCE_END.length);
  }

  // Selective row-level strip mode (get_page case). Parse, filter, render.
  // The parser's lenient posture means malformed rows are silently dropped,
  // which is the safe direction at a privacy boundary — when in doubt,
  // strip rather than leak.
  const { facts } = parseFactsFence(body);
  const keep = new Set(opts.keepVisibility);
  const kept = facts.filter(f => keep.has(f.visibility));
  const replacement = renderFactsTable(kept);
  return body.slice(0, beginIdx) + replacement + body.slice(endIdx + FACTS_FENCE_END.length);
}
