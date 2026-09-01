-- One-time migration adding the Owner/Admin Control Panel's schema
-- (Feature Backlog #8; see schema.prisma's "OWNER/ADMIN CONTROL PANEL"
-- section comment). Safe to run any time -- purely additive, no existing
-- table or column is altered.
-- Run once against the morpheus2 Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f server/prisma/add-admin-panel-tables.sql`).
-- Skip this if you're initializing a brand-new database from scratch --
-- once this ships, the same tables are already folded into
-- manual-supabase-init.sql too.

create table if not exists platform_settings (
  key           text primary key,
  value         text not null,
  updated_by_id text references users(id) on delete set null,
  updated_date  timestamp(3) not null default now()
);

create table if not exists admin_audit_log (
  id           text primary key default gen_random_uuid()::text,
  admin_id     text references users(id) on delete set null,
  action       text not null,
  details      text,
  created_date timestamp(3) not null default now()
);

create table if not exists maintenance_tasks (
  id            text primary key default gen_random_uuid()::text,
  created_by_id text not null references users(id) on delete cascade,
  title         text not null,
  done          boolean not null default false,
  created_date  timestamp(3) not null default now(),
  updated_date  timestamp(3) not null default now()
);

create index if not exists admin_audit_log_created_date_idx on admin_audit_log(created_date);
create index if not exists maintenance_tasks_created_by_id_idx on maintenance_tasks(created_by_id);
