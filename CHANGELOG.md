# Changelog

Alle noemenswaardige wijzigingen aan EdgePickr. Formaat: [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/), nieuwste eerst.

## [9.0.3] - 2026-04-14

### Fixed
- Analyzer vindt nu niet-gescande wedstrijden: threshold versoepeld (100 → 70) en beide teams fuzzy ≥40.
- Analyzer zoekt gisteren/vandaag/morgen (Amsterdam-tz) voor nachtwedstrijden.

### Added
- Analyzer multi-sport support: herkent hints (`nhl`, `nba`, `mlb`, `nfl`, `handbal`, …) en valt zonder hint terug op football + max 3 andere sporten (budget-bewaking).
- `POST /api/clv/backfill` (admin-only): vult `clv_odds` + `clv_pct` achteraf voor bets waar de scheduled check faalde. Rate-limited op 200ms/bet. Schrijft notificatie per succesvolle backfill.

### Docs
- README.md herschreven voor v9.0 (multi-sport, Supabase, CLV backfill).
- CHANGELOG.md toegevoegd.

## [9.0.2] - 2026-04-14

### Fixed
- Pre-match en CLV checks werken nu ook voor nachtwedstrijden: `findGameId` zoekt gisteren/vandaag/morgen (Amsterdam-tz).
- `fixture_id` wordt opgeslagen bij bet-creatie zodat checks na server-herstart betrouwbaar zijn.
- Mijn Bets sorteert chronologisch (19:00 vandaag vóór 01:00 morgen).

### Added
- Automatische CLV retry 5 min later als eerste poging faalt.
- Falende pre-match/CLV checks krijgen een notificatie in de inbox.

## [9.0.1] - 2026-04-14

### Fixed
- CLV fuzzy match: Egyptische clubs, accented namen en prefix-afwijkingen matchen nu correct.
- Analyzer rejectt live wedstrijden (geen pre-match analyse mogelijk).

### Added
- Scan history admin-view (alle users zichtbaar).
- Unit-size logging in Telegram-picks.
- NET Units kolom in tracker.

## [9.0.0] - 2026-04-13

### Added
- Extra markten per sport: NRFI/YRFI (baseball), 1st Half/1st Period Over-Under en Spread, Odd/Even totaal.
- Sport-dropdown in bet-modal + editable in tracker + Handball optie.
- Multi-sport scanner stuurt nu één Telegram-bericht ipv één per sport.

### Fixed
- Bankroll berekent alleen settled bets (open bets tellen niet mee).
- Variance-bug: expected wins werd foutief afgerond.
- CLV display: 0% werd als leeg getoond (gefilterd).
- API usage per sport wordt persistent opgeslagen in Supabase.

## [8.6.0] - 2026-04-13

### Added
- Alle features (pre-match, CLV, calibratie, signal tuning) werken nu voor 6 sporten.

## [8.5.0] - 2026-04-13

### Added
- API usage per sport zichtbaar in status-pagina.
- Dagwinst-widget op dashboard.
- Light theme.

### Fixed
- Odds-drift detectie false positives.

## [8.4.0] - 2026-04-13

### Added
- Sport-iconen in lijsten.
- Bankroll-projectie met open bets meegenomen.

### Fixed
- 6 diverse bugfixes (modal units, scanner top-5 cap, BTTS Nee/Ja, draw/DNB).

## [8.3.0] - 2026-04-13

### Added
- Alle sport-scanners kijken tot morgenochtend 10:00 voor nachtwedstrijden.
- 82 tests (endpoints, calibratie, signals, security).
- Dynamische seizoenen: nooit meer handmatig updaten.

### Fixed
- Hockey + handbal seizoen-formaat (integer ipv split-string).

## [8.2.0] - 2026-04-12

### Added
- Advanced stats per sport (PPG, rebounds, xG, streaks, home dominance).
- Data confidence-score weegt signalen op basis van databronnen.
- Research-based signal-gewichten.

## [8.1.0] - 2026-04-12

### Added
- Baseball + NFL + Handball scanners.
- api-football Pro → api-sports All Sports migratie (6 sporten).

## [8.0.0] - 2026-04-11

### Added
- Multi-sport: NBA + NHL scanners.
- Business plan update (All Sports plan).

---

Oudere versies (v3.x–v7.x): zie git history.
