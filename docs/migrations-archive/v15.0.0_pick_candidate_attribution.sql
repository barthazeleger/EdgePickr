-- EdgePickr v15.0.0 — pick candidate attribution and playability payloads
-- Run with:
--   node scripts/migrate.js docs/migrations-archive/v15.0.0_pick_candidate_attribution.sql

alter table public.pick_candidates
  add column if not exists source_attribution jsonb not null default '{}'::jsonb,
  add column if not exists sharp_anchor jsonb not null default '{}'::jsonb,
  add column if not exists playability jsonb not null default '{}'::jsonb;

create index if not exists pick_candidates_source_attribution_gin
  on public.pick_candidates using gin (source_attribution);

create index if not exists pick_candidates_sharp_anchor_gin
  on public.pick_candidates using gin (sharp_anchor);

create index if not exists pick_candidates_playability_gin
  on public.pick_candidates using gin (playability);

-- Verification:
--   select column_name, data_type
--   from information_schema.columns
--   where table_schema='public'
--     and table_name='pick_candidates'
--     and column_name in ('source_attribution', 'sharp_anchor', 'playability');
