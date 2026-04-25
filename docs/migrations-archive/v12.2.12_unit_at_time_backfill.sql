-- EdgePickr v12.2.12 — D2 backfill van unit_at_time voor legacy bets
--
-- Probleem: bets gelogd vóór v10.10.7 hebben unit_at_time = NULL. lib/bets-data.js
-- `calcStats` valt daarvoor terug op de *current* unitEur uit user-settings, wat
-- historische winU/lossU vertekent zodra Bart's unit ooit verhoogt of verlaagt.
--
-- Fix: éénmalige backfill met de default unitEur (€25). Conservatief: voor de paar
-- bets die met andere unit gelogd zijn (vóór unit-verandering) is dit een approx,
-- maar nog steeds beter dan altijd-current. Voor nieuwe bets wordt unit_at_time
-- expliciet geschreven (sinds v10.10.7).
--
-- Geen data-loss: alleen NULL → 25.0 update. Bestaande non-null waarden worden
-- gerespecteerd. Idempotent: tweede run muteert niets (alle null's al gevuld).

update public.bets
  set unit_at_time = 25.00
  where unit_at_time is null;
