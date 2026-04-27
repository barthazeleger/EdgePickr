-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v12.5.0 — Conviction-route tracking
-- Doctrine-pivot: confidence-gewogen ep-gap. Picks die door de loosened gate
-- kwamen (2pp i.p.v. 3pp boven markt-implied, op basis van sigCount ≥ 6)
-- worden getagd zodat we na ~100 settled rijen kunnen splitsen tussen edge-
-- track en conviction-track CLV/ROI — basis voor v12.5.x-doctrine-decisie:
-- promote, revert, of verder tunen.
--
-- Additive only · idempotent · geen DROP/TRUNCATE/DELETE.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.pick_candidates
  add column if not exists conviction_route boolean not null default false;

-- Partial index: alleen rijen waarvan conviction_route=true ondersteunen de
-- analyse-queries ("welke conviction-picks hadden positieve CLV"). Reguliere
-- (false-default) rijen worden hier niet opgeslagen — index blijft klein.
create index if not exists pick_candidates_conviction_idx
  on public.pick_candidates(conviction_route, created_at desc)
  where conviction_route = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='pick_candidates'
--      and column_name='conviction_route';  -- 1 row, boolean, false default
--
--   select count(*) from public.pick_candidates where conviction_route = true;
--   -- 0 (vult bij eerste scan na deploy)
--
--   -- ANALYSE-QUERY (na ~1 week + 100+ settled rijen):
--   select conviction_route,
--          count(*) as n,
--          avg(case when result = 'W' then 1.0 when result = 'L' then 0.0 end) as winrate,
--          avg(clv_pct) as avg_clv
--     from public.pick_candidates
--    where result in ('W', 'L', 'P')
--      and created_at > now() - interval '14 days'
--    group by conviction_route;
