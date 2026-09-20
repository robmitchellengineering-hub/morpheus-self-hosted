-- What Morpheus may do to a site unprompted, and when (schema.prisma's
-- SiteMaintenancePolicy). Additive and idempotent: safe to re-run.
--
-- Everything defaults to OFF. `scan_enabled` is the safe half — read the site and
-- report — and the three `apply_*` columns are deliberately separate: an owner
-- who asked to be told what is wrong has not asked us to change their site.
--
-- Core MAJOR updates have no automatic column at all; `allow_core_major_manual`
-- only records that a human may be offered it. A column that could be flipped to
-- "auto-apply a major core update" would be a loaded gun in a settings screen.
--
-- Run on prod Supabase via the SQL editor ("Run without RLS") or:
--   node scripts/prod-sql.mjs prisma/add-site-maintenance-policies.sql

CREATE TABLE IF NOT EXISTS site_maintenance_policies (
  id                      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id              text NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  scan_enabled            boolean NOT NULL DEFAULT false,
  day_of_month            integer NOT NULL DEFAULT 1,
  hour_utc                integer NOT NULL DEFAULT 3,
  apply_plugins           boolean NOT NULL DEFAULT false,
  apply_themes            boolean NOT NULL DEFAULT false,
  apply_core_minor        boolean NOT NULL DEFAULT false,
  allow_core_major_manual boolean NOT NULL DEFAULT true,
  last_scan_at            timestamp(3),
  last_result             text,
  created_date            timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date            timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
