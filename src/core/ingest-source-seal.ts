/**
 * B2 write-seal (multi-tenant gate, the gate before tenant #2).
 *
 * Resolves the `source_id` for a POST /ingest webhook write.
 *
 * INVARIANT: ingested content is written to the source the TOKEN is
 * authorized to write — `AuthInfo.sourceId` (from `oauth_clients.source_id`,
 * the client's write authority) — NEVER a client-supplied value. A token has
 * exactly one write authority (`sourceId`; federation is read-only via
 * `federatedRead`), so an inbound `x-gbrain-source-id` header may at most
 * ASSERT that same source. Any other value is a cross-source write attempt
 * and is denied.
 *
 * Bug this seals: pre-fix, `serve-http.ts` took `source_id` directly from the
 * `x-gbrain-source-id` header with no check against the caller's authority
 * (`const sourceId = (req.header('x-gbrain-source-id') || `webhook-${clientId}`)`),
 * letting any write-scoped client inject content into ANY source — the
 * likeliest cross-tenant bleed on the write side. Reads were already
 * source-scoped under the #861 seal; this closes the symmetric write hole.
 *
 * Kept as a pure function with ZERO imports (no req/res/DB, no operations.ts
 * graph) so the isolation property is unit-testable directly, independent of
 * the HTTP/Postgres harness and of node_modules.
 */

/**
 * The only field of the verified token this seal needs: the OAuth client's
 * write authority. Structurally a subset of `core/operations.ts` `AuthInfo`
 * (whose `sourceId?: string` is sourced from `oauth_clients.source_id`), so a
 * real `AuthInfo` is assignable here without importing its module graph.
 */
export interface TokenWriteAuthority {
  sourceId?: string;
}

export type IngestSourceDecision =
  | { ok: true; sourceId: string }
  | { ok: false; attempted: string; authorized: string };

/**
 * @param authInfo      the verified token; `sourceId` is its write authority
 *                      (undefined for legacy/unscoped tokens → 'default',
 *                      mirroring the /mcp dispatch path).
 * @param headerSourceId the raw `x-gbrain-source-id` request header, if any.
 */
export function resolveIngestSourceId(
  authInfo: TokenWriteAuthority,
  headerSourceId: string | undefined,
): IngestSourceDecision {
  // Undefined (legacy bearer / not-yet-scoped client) → 'default', exactly as
  // the /mcp path does (`authInfo.sourceId ?? 'default'`).
  const authorized = authInfo.sourceId ?? 'default';

  if (headerSourceId != null && headerSourceId.length > 0) {
    // Clamp to the legacy 256-char bound BEFORE comparing, so an over-long
    // header cannot diverge from the value that would have been stored.
    const requested = headerSourceId.slice(0, 256);
    if (requested !== authorized) {
      return { ok: false, attempted: requested, authorized };
    }
  }

  // No header, empty header, or header asserting the token's own source.
  return { ok: true, sourceId: authorized };
}
