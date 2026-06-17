/**
 * Entity split correction audit.
 *
 * Best-effort JSONL audit for operator-driven un-merge corrections. The DB
 * rows are the source of truth; this file gives operators a forensic trail
 * without blocking the correction if the audit directory is unavailable.
 */

import { createAuditWriter, computeIsoWeekFilename } from '../audit/audit-writer.ts';

export interface EntitySplitAuditEvent {
  ts: string;
  source_id: string;
  from_slug: string;
  to_slug: string;
  fact_ids_moved: number[];
  links_moved: number;
  links_deduped: number;
  timeline_ids_moved: number[];
  page_aliases_moved: number;
  page_aliases_deduped: number;
  slug_aliases_removed: string[];
  target_state: 'existing' | 'restored' | 'created';
  reason?: string;
}

/** ISO-week-rotated filename: `entity-splits-YYYY-Www.jsonl`. */
export function computeEntitySplitAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('entity-splits', now);
}

const writer = createAuditWriter<EntitySplitAuditEvent>({
  featureName: 'entity-splits',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'entity split audit ',
  errorTrailer: '; correction continues',
});

export function logEntitySplitEvent(
  event: Omit<EntitySplitAuditEvent, 'ts'> & { ts?: string },
): void {
  writer.log({
    ts: event.ts ?? new Date().toISOString(),
    source_id: event.source_id,
    from_slug: event.from_slug,
    to_slug: event.to_slug,
    fact_ids_moved: event.fact_ids_moved,
    links_moved: event.links_moved,
    links_deduped: event.links_deduped,
    timeline_ids_moved: event.timeline_ids_moved,
    page_aliases_moved: event.page_aliases_moved,
    page_aliases_deduped: event.page_aliases_deduped,
    slug_aliases_removed: event.slug_aliases_removed,
    target_state: event.target_state,
    ...(event.reason ? { reason: event.reason } : {}),
  });
}
