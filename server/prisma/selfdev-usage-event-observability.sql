-- Additive-only: the observability columns on usage_events (2026-09-27).
-- Nullable, so every existing row keeps meaning exactly what it meant ("not recorded").

alter table usage_events add column if not exists task text;
alter table usage_events add column if not exists status text;
alter table usage_events add column if not exists duration_ms integer;
