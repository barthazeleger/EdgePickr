-- v15.0.12: Add tsdb_event_stats JSONB column to `bets` for settled-bet
-- enrichment via TSDB lookupeventstats.php. Voedt v15.0.13+ calibration-
-- modellen met shots-on-target / possession / corners zonder de pre-match
-- pick-flow te raken. Worker `lib/jobs/settlement-stats-enrichment.js` doet
-- 1× per dag een batch-update voor settled bets met fixture_id maar zonder
-- tsdb_event_stats.

ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS tsdb_event_stats JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_bets_tsdb_event_stats_null
  ON bets ((tsdb_event_stats IS NULL))
  WHERE uitkomst IN ('W', 'L');

COMMENT ON COLUMN bets.tsdb_event_stats IS
  'v15.0.12: TSDB lookupeventstats.php payload voor settled bets. Shape: {fetched_at, eventId, stats: [{statType, home, away}, ...]}. Null = nog niet enrichted of fixture niet matched.';
