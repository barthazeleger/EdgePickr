-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v10.10.7 — bets.unit_at_time (point-in-time correctness)
--
-- Doctrine: PRIVATE_OPERATING_MODEL.md sectie 5 + 6 Bouwvolgorde.
-- Zonder unit_at_time wordt elke CLV/ROI-analyse die over een unit-wisseling
-- heen loopt retroactief vervormd. Deze kolom legt de unit-grootte (€) vast
-- op het moment dat de bet werd geplaatst.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.bets
  add column if not exists unit_at_time numeric;

comment on column public.bets.unit_at_time is
  'Unit size in EUR op het moment dat de bet werd geplaatst. NULL voor legacy '
  'rows van vóór v10.10.7; lees-paden vallen in dat geval terug op de huidige '
  'user.unitEur (met implicit warning richting historie-vervorming).';

-- Optionele backfill: bestaande open + recent settled bets krijgen huidige
-- unit als beste benadering. Comment uit te zetten als operator de NULL-
-- semantiek expliciet wil houden voor pre-migratie historie-analyses.
--
-- update public.bets
--   set unit_at_time = 25
-- where unit_at_time is null;
