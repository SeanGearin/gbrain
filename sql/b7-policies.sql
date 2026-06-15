-- ============================================================================
-- B7 RLS Backstop — Step 1: row-level security policies (DORMANT on apply)
-- ============================================================================
-- Model B multi-tenant isolation. Design contract:
--   virgil-sean/sessions/phase2-b7-rls-design_2026-06-04.md  (§A, §E)
--
-- WHAT THIS DOES
--   Creates one FOR ALL policy per request-path content table, scoping every
--   row to the session GUC `app.current_source_id` (set per request by
--   PostgresEngine.withSourceScope — design §B). Policies are written with NO
--   `TO <role>` clause, so they apply to PUBLIC — but a role with BYPASSRLS
--   (the incumbent gbrain app role) bypasses them entirely. They only bite a
--   NOBYPASSRLS role (gbrain_tenant, created in b7-role.sql, Step 2).
--
-- WHY APPLYING THIS IS A NO-OP ON LIVE TRAFFIC (design §E)
--   At apply time the only connections are the incumbent BYPASSRLS role
--   (CLI / STDIO mcp-proxy / cron). They bypass these policies. gbrain_tenant
--   does not exist yet and nothing connects as it. Sean's 'default'-source
--   brain is untouched. The policies are dormant until a connection arrives on
--   gbrain_tenant — which only happens at the gated customer-plane integration.
--
-- ORDERING (design §E): policies FIRST (this file), role SECOND (b7-role.sql),
--   connection-string flip LAST (integration). No `TO gbrain_tenant` here so
--   this file has zero dependency on the role existing — apply order is safe.
--
-- HOW TO APPLY (NOT a migrate.ts migration — deliberate)
--   `gbrain apply-migrations` ignores DATABASE_URL and follows config.json to
--   PROD, and the bun-install postinstall hook auto-fires it (ec2-access.md
--   gotchas). A standalone .sql applied by hand via psql keeps B7 off that
--   auto-fire rail. Apply against the intended DB explicitly:
--     psql "$TARGET_DATABASE_URL" -f sql/b7-policies.sql
--   Snapshot first (EBS) — the B2.5 discipline.
--
-- AUTHORITATIVE ENABLED-SET CAVEAT
--   The set of tables with RLS *enabled* on the live box is NOT what this file
--   or src/schema.sql enumerates. Migration v35 installs an event trigger
--   (auto_rls_on_create_table) that ENABLEs RLS on every new public.* table at
--   ddl_command_end. Before relying on coverage, read the real enabled-set from
--   the live database, not from source:
--     SELECT relname FROM pg_class
--      WHERE relrowsecurity AND relkind = 'r'
--        AND relnamespace = 'public'::regnamespace
--      ORDER BY relname;
--   This file policies the request-path CONTENT subset (design D3). Infra /
--   CAT-6 tables are isolated by GRANT exclusion in b7-role.sql, not by policy.
--
-- FAIL-CLOSED ON UNSET VAR
--   current_setting('app.current_source_id', true) returns SQL NULL when the
--   GUC is unset (the `true` = missing_ok). `source_id = NULL` is never true,
--   so an unset var yields ZERO rows under gbrain_tenant — fail closed, not
--   fail open. An empty-string var ('') likewise matches no content row (no
--   row has source_id = ''), so both unset and '' deny. No extra guard needed.
--
-- IDEMPOTENT: each policy is DROP POLICY IF EXISTS-then-CREATE, so re-applying
--   this file is safe. RLS is left ENABLED (it already was, pre-B7); this file
--   only adds policies. It never ENABLEs/DISABLEs RLS and never sets FORCE
--   (design D7 — FORCE buys nothing under BYPASSRLS and risks owner lockout).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- CAT-1 — tables carrying source_id directly. Policy: source_id = the GUC.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS b7_tenant_isolation ON pages;
CREATE POLICY b7_tenant_isolation ON pages FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON ingest_log;
CREATE POLICY b7_tenant_isolation ON ingest_log FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON files;
CREATE POLICY b7_tenant_isolation ON files FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON facts;
CREATE POLICY b7_tenant_isolation ON facts FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON calibration_profiles;
CREATE POLICY b7_tenant_isolation ON calibration_profiles FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON take_proposals;
CREATE POLICY b7_tenant_isolation ON take_proposals FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON take_nudge_log;
CREATE POLICY b7_tenant_isolation ON take_nudge_log FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON think_ab_results;
CREATE POLICY b7_tenant_isolation ON think_ab_results FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON query_cache;
CREATE POLICY b7_tenant_isolation ON query_cache FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

-- slug_aliases / page_aliases: read-path alias lookup tables, source_id directly
-- on each row (see src/core/pglite-schema.ts / migrate.ts). Same CAT-1 shape as
-- their siblings above. The tenant holds SELECT-only on these (b7-role.sql Step
-- 2c), so in practice only the USING leg bites reads; WITH CHECK is carried for
-- parity with the FOR ALL siblings and to stay fail-closed if a write grant is
-- ever added. Mirrors the policy hand-applied to prod 2026-06-14 (18 -> 20).
DROP POLICY IF EXISTS b7_tenant_isolation ON slug_aliases;
CREATE POLICY b7_tenant_isolation ON slug_aliases FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

DROP POLICY IF EXISTS b7_tenant_isolation ON page_aliases;
CREATE POLICY b7_tenant_isolation ON page_aliases FOR ALL
  USING      (source_id = current_setting('app.current_source_id', true))
  WITH CHECK (source_id = current_setting('app.current_source_id', true));

-- ----------------------------------------------------------------------------
-- CAT-2 — no own source_id; derived through page_id -> pages.source_id.
-- Policy: the owning page is in-source. Indexed point-lookup on pages PK.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS b7_tenant_isolation ON content_chunks;
CREATE POLICY b7_tenant_isolation ON content_chunks FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

DROP POLICY IF EXISTS b7_tenant_isolation ON tags;
CREATE POLICY b7_tenant_isolation ON tags FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

DROP POLICY IF EXISTS b7_tenant_isolation ON timeline_entries;
CREATE POLICY b7_tenant_isolation ON timeline_entries FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = timeline_entries.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = timeline_entries.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

DROP POLICY IF EXISTS b7_tenant_isolation ON page_versions;
CREATE POLICY b7_tenant_isolation ON page_versions FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = page_versions.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = page_versions.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

DROP POLICY IF EXISTS b7_tenant_isolation ON raw_data;
CREATE POLICY b7_tenant_isolation ON raw_data FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = raw_data.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = raw_data.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

DROP POLICY IF EXISTS b7_tenant_isolation ON takes;
CREATE POLICY b7_tenant_isolation ON takes FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

-- ----------------------------------------------------------------------------
-- CAT-2 special: links (design D4 — tighten-first).
--   USING  : visibility anchored on the OWNING page (from_page_id in-source).
--   WITH CHECK: BOTH endpoints in-source on write, so a tenant can never author
--   an edge that points into another source's brain (edge-into-foreign-brain
--   is never legitimate on the Model B shared DB — Sean grounded D4 on this).
--   from_page_id and to_page_id are both INTEGER NOT NULL (schema.sql links
--   block), so no NULL-handling is required. origin_page_id (nullable) is not
--   scoped — it is provenance, not a traversable edge.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS b7_tenant_isolation ON links;
CREATE POLICY b7_tenant_isolation ON links FOR ALL
  USING      (EXISTS (SELECT 1 FROM pages p WHERE p.id = links.from_page_id
                      AND p.source_id = current_setting('app.current_source_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM pages p WHERE p.id = links.from_page_id
                      AND p.source_id = current_setting('app.current_source_id', true))
              AND
              EXISTS (SELECT 1 FROM pages p WHERE p.id = links.to_page_id
                      AND p.source_id = current_setting('app.current_source_id', true)));

-- ----------------------------------------------------------------------------
-- CAT-4 — array membership. source_ids TEXT[]; the GUC must be a member.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS b7_tenant_isolation ON eval_candidates;
CREATE POLICY b7_tenant_isolation ON eval_candidates FOR ALL
  USING      (current_setting('app.current_source_id', true) = ANY(source_ids))
  WITH CHECK (current_setting('app.current_source_id', true) = ANY(source_ids));

-- ----------------------------------------------------------------------------
-- CAT-5 — the sources registry itself (design D5). The tenant may read/scope
-- ONLY its own row; it must never enumerate the tenant list ("never should be
-- able to see who else has accounts"). Provision/archive WRITES to sources run
-- on the privileged admin connection (two-DSN split, D6), never gbrain_tenant.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS b7_tenant_isolation ON sources;
CREATE POLICY b7_tenant_isolation ON sources FOR ALL
  USING      (id = current_setting('app.current_source_id', true))
  WITH CHECK (id = current_setting('app.current_source_id', true));

COMMIT;

-- ============================================================================
-- NOT POLICIED HERE (deliberate — design §A):
--   * oauth_clients / oauth_tokens / oauth_codes / access_tokens — auth-bootstrap
--     (read to DISCOVER the source before any scope exists). Scoped by GRANT
--     SELECT only in b7-role.sql, not by row policy (chicken-and-egg).
--   * CAT-6 infra (config, minion_jobs, subagent_*, gbrain_cycle_locks,
--     dream_verdicts, mcp_request_log, eval_* caches, budget_*, drift_decisions,
--     code_edges_*, file_migration_ledger, synthesis_evidence, ...) — no source
--     path; isolated by GRANT EXCLUSION (no grant to gbrain_tenant) in
--     b7-role.sql. A table the tenant role cannot touch cannot leak.
--   D3 BANKED CONDITION: if a future change grants gbrain_tenant access to any
--   currently-excluded table, its row policy lands in that same change, not after.
-- ============================================================================
