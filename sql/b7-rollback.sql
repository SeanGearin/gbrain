-- ============================================================================
-- B7 RLS Backstop — ROLLBACK (reverse order of policies + role)
-- ============================================================================
-- Design contract: virgil-sean/sessions/phase2-b7-rls-design_2026-06-04.md (§E)
--
-- This reverses b7-policies.sql + b7-role.sql. It is safe because nothing
-- destructive happens to DATA: dropping the policies returns the tables to the
-- pre-B7 "RLS enabled, zero policies" state — which, under the BYPASSRLS
-- incumbent, is byte-identical to today's behavior. RLS stays ENABLED (it was
-- enabled before B7; we never touch ENABLE/DISABLE — design D7).
--
-- ORDER (reverse of forward):
--   R3 (out-of-band, not here): repoint the customer-plane serve-http
--      GBRAIN_DATABASE_URL back to the incumbent role. Instant, config-only.
--      Do this FIRST in a live rollback so no connection is on gbrain_tenant
--      before R2 drops it.
--   R2: drop the role (below) — only after no connection uses it.
--   R1: drop the policies (below).
--
-- HOW TO APPLY
--   psql "$TARGET_DATABASE_URL" -f sql/b7-rollback.sql
--   Run as a role that can DROP ROLE + DROP POLICY (incumbent/superuser).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- R2 — tear down the role. REVOKE then DROP. Idempotent (IF EXISTS guards).
-- REVOKE ... FROM is required before DROP ROLE if grants exist. We revoke the
-- exact grants made in b7-role.sql, then drop. If a connection is still on the
-- role, DROP ROLE will error — that is the intended safety interlock (do R3
-- first). Sequence grants are dropped implicitly when the role is dropped, but
-- we REVOKE table grants explicitly so a partial state re-applies cleanly.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_tenant') THEN
    -- Revoke everything this role was granted in this schema, then drop it.
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gbrain_tenant';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM gbrain_tenant';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM gbrain_tenant';
    EXECUTE 'DROP ROLE gbrain_tenant';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- R1 — drop the policies. RLS remains ENABLED on every table (pre-B7 state).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS b7_tenant_isolation ON pages;
DROP POLICY IF EXISTS b7_tenant_isolation ON ingest_log;
DROP POLICY IF EXISTS b7_tenant_isolation ON files;
DROP POLICY IF EXISTS b7_tenant_isolation ON facts;
DROP POLICY IF EXISTS b7_tenant_isolation ON calibration_profiles;
DROP POLICY IF EXISTS b7_tenant_isolation ON take_proposals;
DROP POLICY IF EXISTS b7_tenant_isolation ON take_nudge_log;
DROP POLICY IF EXISTS b7_tenant_isolation ON think_ab_results;
DROP POLICY IF EXISTS b7_tenant_isolation ON query_cache;
DROP POLICY IF EXISTS b7_tenant_isolation ON content_chunks;
DROP POLICY IF EXISTS b7_tenant_isolation ON tags;
DROP POLICY IF EXISTS b7_tenant_isolation ON timeline_entries;
DROP POLICY IF EXISTS b7_tenant_isolation ON page_versions;
DROP POLICY IF EXISTS b7_tenant_isolation ON raw_data;
DROP POLICY IF EXISTS b7_tenant_isolation ON takes;
DROP POLICY IF EXISTS b7_tenant_isolation ON links;
DROP POLICY IF EXISTS b7_tenant_isolation ON eval_candidates;
DROP POLICY IF EXISTS b7_tenant_isolation ON sources;
DROP POLICY IF EXISTS b7_tenant_isolation ON slug_aliases;
DROP POLICY IF EXISTS b7_tenant_isolation ON page_aliases;

COMMIT;

-- NB: we deliberately do NOT run `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`.
-- RLS was enabled before B7 (schema.sql + the v35 event trigger). Disabling it
-- would diverge from the schema baseline and fight the event trigger on the
-- next CREATE TABLE. Dropping policies is the correct, sufficient rollback.
