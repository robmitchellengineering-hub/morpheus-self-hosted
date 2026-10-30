-- Additive: our own package registry. Nothing existing is altered.
create table if not exists packages (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  version      text not null,
  sha256       text not null,
  size         integer not null,
  notes        text,
  published_by text,
  bytes        bytea not null,
  published_at timestamptz not null default now()
);
create unique index if not exists packages_name_version on packages (name, version);
create index if not exists packages_name_published on packages (name, published_at desc);
