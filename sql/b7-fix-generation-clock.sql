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
-- THE DURABLE FIX IS IN ENGINE SOURCE, NOT THIS SCRIPT. The SECURITY DEFINER
--   + pinned search_path now live on the function DEFINITION at every site
--   (src/schema.sql -> src/core/schema-embedded.ts, src/core/migrate.ts v107,
--   src/core/pglite-schema.ts), pinned by P-13a/b in
--   test/e2e/b8-rls-proof.test.ts. That matters because
--   PostgresEngine.initSchema() replays the full embedded schema blob at
--   EVERY engine startup, and CREATE OR REPLACE resets function attributes —
--   so an ALTER-only fix is structurally incapable of sticking.
--
-- WHEN TO APPLY (and what this script can and cannot do):
--   (a) PRE-v107 databases: this script is a LITERAL NO-OP. The DO block only
--       fires if the function already exists, so applying it "ahead of" the
--       upgrade provides ZERO protection. The first startup of an upgraded
--       binary replays SCHEMA_SQL — which creates the function BEFORE
--       migration v107 formally runs — so only the binary's own definition
--       decides whether the function is safe at that moment.
--   (b) On an UNPATCHED engine binary (one whose SCHEMA_SQL still carries the
--       non-SECURITY-DEFINER form): this script's effect is CLOBBERED at the
--       next engine restart — deploy, reboot, crash-recovery — when initSchema
--       replays the blob. Emergency triage only, knowing it dies at the next
--       restart.
--   (c) Its only DURABLE role: post-upgrade belt-and-suspenders on a binary
--       that already carries the source-definition patch (idempotent over the
--       already-safe function), e.g. immediately after an upgrade, before the
--       first tenant write, without waiting to verify which definition the
--       replay applied.
--   Single-role (BYPASSRLS-only) deploys never hit the bug; the script is
--   still safe for them.
--
-- VERIFY (any time): expect prosecdef = t and the pinned search_path:
--     SELECT prosecdef, proconfig FROM pg_proc
--     WHERE proname = 'bump_page_generation_clock_fn';
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
