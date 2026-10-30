-- Additive: the table the SDK's corpus collector writes to. Nothing existing is altered.
create table if not exists corpus_observations (
  id          uuid primary key default gen_random_uuid(),
  install_id  text,
  recipe      text not null,
  verdict     text not null,
  trials      integer,
  check_kind  text,
  repo        text,
  license     text,
  observed_at timestamptz not null,
  received_at timestamptz not null default now()
);
create unique index if not exists corpus_observations_dedupe
  on corpus_observations (coalesce(install_id, ''), recipe, verdict, observed_at);
create index if not exists corpus_observations_recipe_verdict
  on corpus_observations (recipe, verdict);
create index if not exists corpus_observations_received_at
  on corpus_observations (received_at);
