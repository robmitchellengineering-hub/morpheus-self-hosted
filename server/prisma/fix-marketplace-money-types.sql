-- One-time fix for the morpheus2 Supabase project, which was already
-- initialized from an earlier version of manual-supabase-init.sql that had
-- two bugs in the marketplace tables (found during a 2026-08-26 audit
-- against the original Base44 app's actual logic):
--
-- 1. `templates.price` / `purchases.amount|platform_cut|seller_cut` were
--    declared `integer` with a "// cents" comment, but every handler in
--    server/src/functions/ (publishTemplate.js, stripeWebhook.js, etc.)
--    always reads/writes these as plain DOLLAR values (e.g. 9.99) — an
--    unmodified port of the original Base44 logic, which used untyped
--    numbers for these fields. An `integer` column silently rejects any
--    non-whole-dollar value, which would make publishing almost any real
--    paid template (or even the $0.50 minimum price) fail at the database
--    level. Fixed by widening these columns to `double precision`, matching
--    what the application code has always actually stored.
-- 2. `purchases.template_id` was `not null ... on delete cascade`, so
--    deleting a seller's account cascaded through their Template rows and
--    silently deleted every OTHER buyer's purchase/receipt for anything
--    they'd bought from that seller. The original only ever deleted the
--    acting user's own purchases (as a buyer), never touched other users'
--    records. Fixed by making the column nullable with `on delete set
--    null`, so a deleted template just orphans the reference instead of
--    deleting other people's purchase history.
--
-- Safe to run even with zero existing rows in these tables (no production
-- purchases have happened yet, per the 2026-08-24 build status doc) — but
-- written as non-destructive ALTERs regardless, in case that's changed by
-- the time this runs. Run this once against the morpheus2 Supabase project
-- (SQL Editor, or `psql "$DATABASE_URL" -f server/prisma/fix-marketplace-money-types.sql`).
-- If you're instead initializing a brand-new database from scratch, you
-- don't need this file at all — manual-supabase-init.sql already has the
-- fix baked in.

alter table purchases
  drop constraint if exists purchases_template_id_fkey;

alter table purchases
  alter column template_id drop not null;

alter table purchases
  add constraint purchases_template_id_fkey
    foreign key (template_id) references templates(id) on delete set null;

alter table templates
  alter column price type double precision using price::double precision;

alter table purchases
  alter column amount type double precision using amount::double precision,
  alter column platform_cut type double precision using platform_cut::double precision,
  alter column seller_cut type double precision using seller_cut::double precision;
