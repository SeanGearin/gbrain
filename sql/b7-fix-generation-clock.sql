-- ============================================================================
-- B7 forward-compat fix — page_generation_clock trigger vs gbrain_tenant
-- ============================================================================
-- Found by the B8 proof suite (2026-06-11) running against the v0.42 schema.
--
-- THE BUG (an upgrade time bomb, not a live break on the v0.40.6-based prod):
--   Migration v107 (v0.41.25.0, page_generation_clock_and_statement_trigger)
--   adds a FOR EACH STATEMENT trigger on pages — bump_page_generation_clock_trg
--   — whose function does `UPDATE page_generation_clock SET value = value + 1`.
--   The function is NOT SECURITY DEFINER, so it runs as the INVOKING role.
--   gbrain_tenant has no grant on page_generation_clock (CAT-6 by default), so
--   the moment the engine upgrades past v0.41.25.0, EVERY tenant-plane
--   INSERT/UPDATE/DELETE on pages — including 0-row statements, because the
--   trigger is statement-level — dies with 42501 "permission denied for table
--   page_generation_clock". Fail-closed (no leak), but a total write lockout
--   for the customer plane.
--
-- THE FIX: make the trigger function SECURITY DEFINER with a pinned
--   search_path. It then runs as the function owner (the incumbent/BYPASSRLS
--   role that applied the migration), which has both the grant and RLS bypass.
--   This is the standard pattern for counter/audit triggers and is strictly
--   better than granting the tenant UPDATE on the clock table — that
--   alternative ALSO needs a row policy (the table is RLS-enabled by the v35
--   event trigger, so a grant alone yields a silent 0-row no-bump, which would
--   quietly break query-cache invalidation for tenant writes — worse than the
--   loud 42501).
--
-- WHEN TO APPLY: with (or any time before) the engine upgrade that brings
--   migration v107 to a database serving a NOBYPASSRLS tenant role. Harmless
--   to apply earlier — the DO block no-ops when the function doesn't exist
--   yet, and re-applying is idempotent. Single-role (BYPASSRLS-only) deploys
--   never hit the bug; the fix is still safe for them.
--
-- HOW TO APPLY (same rail as the other B7 files — by hand via psql, never
--   apply-migrations):
--     psql "$TARGET_DATABASE_URL" -f sql/b7-fix-generation-clock.sql
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'bump_page_generation_clock_fn' AND n.nspname = 'public'
  ) THEN
    ALTER FUNCTION public.bump_page_generation_clock_fn() SECURITY DEFINER;
    -- Pin search_path: mandatory hygiene for SECURITY DEFINER (prevents
    -- malicious-schema shadowing of the unqualified table reference).
    ALTER FUNCTION public.bump_page_generation_clock_fn()
      SET search_path = public, pg_temp;
  END IF;
END $$;

COMMIT;
