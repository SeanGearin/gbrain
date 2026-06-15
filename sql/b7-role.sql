-- ============================================================================
-- B7 RLS Backstop — Step 2: the restricted customer-plane role gbrain_tenant
-- ============================================================================
-- Design contract: virgil-sean/sessions/phase2-b7-rls-design_2026-06-04.md (§C, §E)
-- Approved decisions: D1 (ADD a role, never ALTER the incumbent), D2 (GRANT-
-- exclusion for CAT-6 infra), D6 (two-DSN split), D8 (ship dormant role + policies).
--
-- WHAT THIS DOES
--   Creates gbrain_tenant: LOGIN, NOBYPASSRLS, no superuser, no createrole/db.
--   GRANTs it DML on exactly the request-path content tables, SELECT-only on the
--   auth-bootstrap tables, and USAGE on those tables' identity sequences ONLY.
--   Everything else in the schema gets NO grant — CAT-6 infra (minion_jobs,
--   config, locks, mcp_request_log, ...) is isolated by exclusion: the tenant
--   role gets `permission denied` on first touch. That is the design's
--   load-bearing simplification (a table the role cannot touch cannot leak).
--
-- WHY THE INCUMBENT IS UNTOUCHED (D1)
--   This file never references the incumbent app role. It does not ALTER it,
--   does not strip BYPASSRLS, does not change its grants. Sean's 'default'-source
--   brain runs on the incumbent BYPASSRLS role via CLI/STDIO and is byte-identical
--   before and after B7. The ONLY thing that ever connects as gbrain_tenant is
--   the customer-plane serve-http op-dispatch pool (GBRAIN_DATABASE_URL), wired
--   at the gated integration step — not by this file.
--
-- TWO-DSN SPLIT (D6) — what gbrain_tenant is NOT used for
--   The customer-plane serve-http holds TWO connections:
--     * tenant pool  (this role)         — op dispatch, wrapped in withSourceScope
--     * privileged   (GBRAIN_ADMIN_DATABASE_URL, the incumbent/admin role)
--                                        — /admin/* handlers + mcp_request_log
--                                          audit writes ONLY
--   gbrain_tenant therefore does NOT need INSERT on mcp_request_log, nor write
--   on sources/oauth_clients — those ride the privileged connection. The GRANT
--   manifest below is exactly the op-dispatch surface, nothing more.
--
-- ORDERING (design §E): inside this file — CREATE ROLE NOLOGIN first, GRANTs
--   second, ALTER ROLE ... LOGIN last — so there is never a window where the
--   role can log in with only PUBLIC-default privileges. Across files: apply
--   b7-policies.sql BEFORE this, so the instant gbrain_tenant becomes reachable
--   enforcement is already complete (policies-complete-before-role-reachable).
--
-- HOW TO APPLY (NOT a migrate.ts migration — gbrain manages no roles)
--   Supply the password out-of-band; never hardcode it:
--     psql "$TARGET_DATABASE_URL" -v tenant_password="$GBRAIN_TENANT_PASSWORD" \
--          -f sql/b7-role.sql
--   Run as a role that can CREATE ROLE + GRANT (the incumbent/superuser on the box).
--   Snapshot first (EBS) — the B2.5 discipline.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Step 2a — create the role with NO login first (no reachable window yet).
-- Idempotent: skip creation if it already exists (re-apply safe).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_tenant') THEN
    CREATE ROLE gbrain_tenant NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  ELSE
    -- enforce the security-relevant attributes even on re-apply
    ALTER ROLE gbrain_tenant NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
  END IF;
END $$;

-- The role needs schema access before any table grant is usable.
GRANT USAGE ON SCHEMA public TO gbrain_tenant;

-- ----------------------------------------------------------------------------
-- Step 2b — DML grants: exactly the request-path content tables (design §C).
-- These are the tables b7-policies.sql row-scopes; the GRANT lets the role
-- reach them, the POLICY confines it to its own source. Both are required.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pages,
  content_chunks,
  links,
  tags,
  timeline_entries,
  page_versions,
  raw_data,
  takes,
  facts,
  files,
  ingest_log,
  query_cache,
  calibration_profiles,
  take_proposals,
  take_nudge_log,
  think_ab_results,
  eval_candidates
TO gbrain_tenant;

-- ----------------------------------------------------------------------------
-- Step 2c — SELECT-only on the tenant's own-row source registry + the two
-- read-path alias tables.
--   sources: SELECT is row-confined to the tenant's own row by the CAT-5 policy.
--   WRITES ride the privileged connection (D6), never this role.
--
--   slug_aliases / page_aliases: read-path lookup tables. resolveSlugWithAlias
--   (wikilink redirect) and the free-text alias leg of search read these as the
--   tenant on the request path — find_experts is one consumer. Both carry
--   source_id directly and are row-confined to the tenant's own source by their
--   CAT-1 policies in b7-policies.sql. SELECT-only by design: the tenant never
--   writes aliases on the request path (re-ingest authoring rides the trusted
--   local CLI / privileged plane), so they deliberately get NO DML and NO
--   sequence USAGE — matching the live grant hand-applied to prod 2026-06-14
--   (policies-first then SELECT-only grant; policy count 18 -> 20). Syncing the
--   grant here makes any role built FROM this manifest carry it; b8-rls-proof
--   at 20 is the executable proof.
--
-- The oauth_clients / oauth_tokens / oauth_codes / access_tokens SELECT grants
-- that used to live here (the CAT-3 bearer-bootstrap carve-out) were VESTIGIAL:
-- the bearer -> source resolution (verifyAccessToken) runs on the privileged
-- connection (D6), not the tenant pool, so the tenant role never read these in
-- production. They were RLS-dead (no row policy → SELECT returned 0 rows, never
-- a leak — proven by the old P-11) and were REVOKEd from gbrain_tenant on prod
-- 2026-06-11 (runbook R-2). Removing them here brings shipped SQL back in line
-- with the live grant manifest. The tenant now gets `permission denied` on
-- these four tables (deny-by-GRANT, CAT-6 style), pinned by the rewritten P-11
-- in test/e2e/b8-rls-proof.test.ts.
-- ----------------------------------------------------------------------------
GRANT SELECT ON
  sources,
  slug_aliases,
  page_aliases
TO gbrain_tenant;

-- ----------------------------------------------------------------------------
-- Step 2d — sequence USAGE, scoped to the DML-granted tables ONLY (per build
-- instruction: not GRANT ... ON ALL SEQUENCES IN SCHEMA). pg_get_serial_sequence
-- resolves each table's identity sequence by name, independent of SERIAL vs
-- BIGSERIAL. Tables without a serial 'id' (e.g. query_cache — text PK) resolve
-- to NULL and are skipped. INSERT needs nextval() USAGE on the backing sequence.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t       text;
  seqname text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pages','content_chunks','links','tags','timeline_entries','page_versions',
    'raw_data','takes','facts','files','ingest_log','eval_candidates',
    'calibration_profiles','take_proposals','take_nudge_log','think_ab_results'
  ]
  LOOP
    seqname := pg_get_serial_sequence(t, 'id');
    IF seqname IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO gbrain_tenant', seqname);
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Step 2e — LAST: make the role login-capable, now that grants are in place.
-- Password supplied out-of-band as the psql var :tenant_password.
-- ----------------------------------------------------------------------------
\if :{?tenant_password}
  ALTER ROLE gbrain_tenant WITH LOGIN PASSWORD :'tenant_password';
\else
  \echo '!! tenant_password not supplied — role left NOLOGIN.'
  \echo '!! Re-run: psql ... -v tenant_password="$GBRAIN_TENANT_PASSWORD" -f sql/b7-role.sql'
\endif

COMMIT;
