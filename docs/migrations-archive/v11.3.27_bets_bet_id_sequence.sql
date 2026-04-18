-- v11.3.27 Reviewer-fix: atomic bet_id allocator via PostgreSQL sequence.
--
-- Probleem: `lib/bets-data.js writeBet` gebruikte `SELECT MAX(bet_id) + 1` +
-- retry-on-conflict. Reviewer bevestigd: onder ~6 concurrent writes valt 1
-- uit na max retries ("5 attempts failed, duplicate key"). Race-condition
-- bleef bestaan, alleen gemitigeerd.
--
-- Fix: maak `bet_id` een echte auto-incrementing identity via sequence.
-- Nieuwe inserts zonder expliciete bet_id krijgen een unieke waarde via
-- `nextval(...)`. writeBet gaat hier naartoe bewegen; de retry-loop blijft
-- als defensive fallback voor legacy rows zonder sequence.
--
-- Apply via: `node scripts/migrate.js docs/migrations-archive/v11.3.27_bets_bet_id_sequence.sql`
-- Idempotent: gebruikt `IF NOT EXISTS` + `COALESCE(MAX, 0) + 1` voor setval.

-- 1. Zorg dat de sequence bestaat.
CREATE SEQUENCE IF NOT EXISTS bets_bet_id_seq;

-- 2. Zet de sequence op MAX(bet_id) + 1 zodat de volgende nextval() boven alle
--    bestaande rijen uitkomt. `false` voorkomt een dubbele increment bij de
--    eerste nextval().
SELECT setval(
  'bets_bet_id_seq',
  COALESCE((SELECT MAX(bet_id) FROM public.bets), 0) + 1,
  false
);

-- 3. Koppel de sequence als default aan bet_id.
ALTER TABLE public.bets
  ALTER COLUMN bet_id SET DEFAULT nextval('bets_bet_id_seq');

-- 4. Ownership op de kolom zodat drops correct cascaden.
ALTER SEQUENCE bets_bet_id_seq OWNED BY public.bets.bet_id;
