-- v15.4 · Per-odds-bucket audit kolom (PLAN §5.1, Codex finding #2).
-- Voegt `odds_bucket` toe aan `bets` zodat retrospectieve audits per bucket
-- {low ≤2.0 · mid 2.0-3.0 · high >3.0} performant kunnen draaien zonder
-- elke odds → bucket-derivatie in app-laag te doen. Helper-functie
-- `lib/picks::oddsBucket(odd)` blijft canonical voor write-time + audit-script.

ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS odds_bucket TEXT DEFAULT NULL;

ALTER TABLE bets
  DROP CONSTRAINT IF EXISTS bets_odds_bucket_check;

ALTER TABLE bets
  ADD CONSTRAINT bets_odds_bucket_check
  CHECK (odds_bucket IS NULL OR odds_bucket IN ('low', 'mid', 'high'));

CREATE INDEX IF NOT EXISTS idx_bets_odds_bucket_settled
  ON bets (odds_bucket, datum)
  WHERE uitkomst IN ('W', 'L');

COMMENT ON COLUMN bets.odds_bucket IS
  'v15.4: low (odds ≤ 2.0) / mid (2.0 < odds ≤ 3.0) / high (odds > 3.0). Bij write-time afgeleid uit execution-odds via lib/picks::oddsBucket(). NULL voor pre-v15.4 history — audit-script valt dan terug op runtime-derivatie.';
