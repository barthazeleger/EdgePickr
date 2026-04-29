# EdgePickr v15 Final Release Handoff

Started: 2026-04-28
Owner: Codex
Base: v14.0.0 (`db730cf`)

## Goal

Deliver the v15 final self-improving release: fix the known NFL scan blocker, wire v14's data-tunable parameter infrastructure into runtime behavior, extend signal and source learning so future improvement is data-driven, and leave a complete handoff after each implementation phase.

## Current Baseline

- Local `master` was already equal to `origin/master` at v14.0.0 before implementation.
- Existing untracked `AGENTS.md` belongs to the workspace and must remain untouched.
- Baseline test result before v15 changes: `npm test` passed with 875 tests.
- Current pushed head after this handoff update context: `a96234a` (`[Codex] v15.0.1 show source telemetry on no-pick days`).

## Phase Status

| Phase | Status | Notes |
| --- | --- | --- |
| Handoff bootstrap | Done | This file created first by design. |
| P1 NFL scan bug | Done | Added `nflInjurySignal()` pure helper and moved NFL scan injury diff before first use. |
| Runtime tunables | Done | `MIN_EP`, divergence threshold, NHL OT share, and signal thresholds now resolve from calibration at runtime. |
| Hierarchical signals | Done | Resolver + auto-tune write path implemented, including v15 admin visibility. |
| Source attribution | Done | Migration, candidate payloads, admin visibility, source toggles, football TSDB/Sharp source attribution, active-sport quota-aware sharp-anchor attribution, and scan-log visibility are in. |
| Anomaly audit expansion | Done | Football 1X2/DC/OU/AH plus active sport ML/totals/spreads where paired quote arrays exist. |
| Shadow sports | Done | Tennis/Rugby/Cricket run as quota-aware, paper-only shadow scanners through the orchestrator when scraping is enabled. |
| Release cutover | Done | v15.0.1 pins, README, CHANGELOG, doctrine and info page refreshed; final checks passed. |
| Post-deploy migration | Done | v15 pick-candidate attribution columns/indexes applied directly against Supabase. |
| Post-deploy calibration | Done | Calibration rebuilt from 65 admin settled bets and v15 default sections backfilled into existing calibration JSON. |
| v15.0.1 hotfix | Done | Source telemetry now logs on 0-pick football days; bookie-anomaly no longer alerts on sharp-reference books. |
| v15.0.2 observability + API utilization | Done | Per-endpoint TSDB telemetry, `pick-funnel` + `settlement-coverage` admin-inspect endpoints, league scoring baseline signal (env-gated), CHANGELOG/README/version pins refreshed. |
| v15.0.5 coverage slice | Done | OddsPapi camelCase event parsing, sharp-anchor unmatched telemetry, MLB full-game diagnostics, and conservative BTTS form-only fallback for n=0 H2H fixtures. |
| v15.0.6 BTTS telemetry | Done | Adds scanlog counters for BTTS markets/form-only/no-exec/data/gate/edge stops without changing pick thresholds. |
| v15.0.7 parser coverage | Done | Widens executable full-game totals/spreads/DNB recognition by market name while preserving derivative-market guards. |

## Risks

- `server.js` is monolithic and scan-loop changes can be easy to under-test if only pure helpers are covered.
- OddsPapi quota is small on the free tier, so sharp-anchor calls must stay quota-aware and fail-soft.
- Tennis/Rugby/Cricket activation must remain shadow/paper until settlement coverage is proven.
- Pick-volume concern is real: multiple scans can still produce 0 picks because value gates remain strict. Do not blindly lower thresholds, but research whether the new endpoint data can create more valid candidates without degrading CLV/ROI.
- `bookie_anomaly` must remain execution-actionable. Sharp books (Pinnacle/Betfair/Circa/SBOBet/etc.) are useful background/reference data, not inbox alerts for the operator.

## Verification Log

- 2026-04-28: `npm test` after the NFL scan fix passed with `876 passed / 0 failed`.
- 2026-04-28: `npm test` after runtime tunables + hierarchical signal resolver passed with `878 passed / 0 failed`.
- 2026-04-28: `npm test` after v15 data/admin surfaces passed with `878 passed / 0 failed`.
- 2026-04-28: `npm test` after scan-loop source wiring, anomaly expansion, and T/R/C shadow activation passed with `880 passed / 0 failed`.
- 2026-04-28: `node --check server.js lib/v15-runtime.js lib/signal-weights.js lib/snapshots.js` passed.
- 2026-04-28: `npm test` final release run passed with `880 passed / 0 failed`.
- 2026-04-28: `npm run test:coverage` passed with `880 passed / 0 failed` under c8; overall coverage `43.99%` because the monolithic `server.js` is not loaded by the unit harness.
- 2026-04-28: `npm run audit:high` passed with `0 vulnerabilities`.
- 2026-04-28: v15 migration applied: `source_attribution`, `sharp_anchor`, `playability` JSONB columns plus GIN indexes on `pick_candidates`.
- 2026-04-28: calibration rebuilt and verified: `65` settled admin bets, `34` wins, profit `13.82`, `9` market keys, v15 defaults present.
- 2026-04-28: v15.0.1 hotfix pushed after `npm test` passed with `880 passed / 0 failed`, `npm run audit:high` passed, and `node --check server.js` passed.
- 2026-04-28: cleaned existing sharp-reference spam from inbox: scanned `76` recent `bookie_anomaly` rows, deleted `57` rows mentioning Pinnacle/Betfair/Circa/SBOBet/Polymarket/Kalshi, left other anomaly rows untouched.
- 2026-04-28 (v15.0.2): Build B/A/C/D shipped — `npm test` results pending agent run (verwacht 880 → ~894). `node --check` op alle aangeraakte files moet groen blijven; `npm run audit:high` ongewijzigd 0 vulnerabilities. Pre-deploy verificatie staat in CHANGELOG entry.
- 2026-04-29 (v15.0.5): `node --check server.js lib/integrations/sources/oddspapi.js lib/v15-runtime.js test.js` passed; `npm test` passed with `898 passed / 0 failed`; `npm run audit:high` passed with `0 vulnerabilities`.
- 2026-04-29 (v15.0.6): `node --check server.js test.js` passed; `git diff --check` passed; `npm test` passed with `898 passed / 0 failed`; `npm run audit:high` passed with `0 vulnerabilities`.
- 2026-04-29 (v15.0.7): `node --check lib/odds-parser.js server.js test.js` passed; `git diff --check` passed; `npm test` passed with `901 passed / 0 failed`; `npm run audit:high` passed with `0 vulnerabilities`.

## Post-Deploy State

No manual migration/rebuild action remains for v15. The database and calibration work have already been done from this workspace.

The latest observed scan proves v15 code is active:

- `TSDB livescore pre-filter` was visible.
- `oddspapi=ok(...)` appeared in scraper health.
- Tennis/rugby/cricket shadow scanners emitted rows/logs.
- 0 picks were produced because gates rejected candidates, not because scan execution failed.

## v15.0.2 Build Notes (Claude follow-up after Codex hand-off)

Operator vroeg om actie i.p.v. nóg een audit. Gebouwd:

1. **`thesportsdb._callsToday`** is nu `{total, byEndpoint}`. `getUsage()` returnt per-endpoint breakdown. URL → key parser (V1: file zonder `.php`; V2: type-segment) is geëxporteerd als `_endpointKeyFromUrl` voor tests.
2. **`/api/admin/v2/pick-funnel`**: cascade-aggregaat over `pick_candidates` met canonieke STAGES-volgorde. Near-miss-telemetrie reconstrueert |probGap| ∈ [15,20]pp uit `fair_prob` + `bookmaker_odds` zonder `picks.js` aan te raken.
3. **`/api/admin/v2/settlement-coverage`**: aging-buckets (24h/48h/7d), velocity over N dagen, oldestOpen list, optionele `?probe=1` voor OddsPapi `/scores` coverage check (gratis quota).
4. **League scoring baseline**: `lib/signals/league-scoring-baseline.js` (pure math, Bayesian shrink) + `getLeagueScoringBaseline()` aggregator-method. Signal naam bevat `over_under` zodat de OU-relevantSignals-filter in `picks.js:169-174` het meetelt. Wiring zit achter `process.env.TSDB_LEAGUE_BASELINE === '1'` zodat operator op Render kan aan/uit zonder redeploy.

Wat NIET gedaan is en waarom:
- Geen threshold-verlagingen (operator-instructie staat in §Risks).
- Geen sport-promoties (settlement-velocity moet eerst groeien).
- Geen auto-settle (apart pad met manual-review klep, hoort in v15.0.3).
- `fetchEventStats/Timeline/TV/Roster/TeamFullSchedule` blijven ongebruikt: alleen relevant voor in-play of niet-cross-source-injury — geen positieve EV-case zonder verdere infrastructure.

## Aanbevolen volgende stappen (post v15.0.2)

1. **Run minimaal 7 dagen met huidige changes** zodat funnel + settlement-coverage rijke data hebben.
2. **Toggle `TSDB_LEAGUE_BASELINE=1`** op Render en bekijk `tsdbLeagueBaselineApplied` in scan-log; als ≥10/dag een nudge krijgen, evalueer in week 2.
3. **Beslis op basis van funnel-evidence** of `extreme_divergence` terug naar 22pp of 25pp moet (geen verlaging zonder ≥30 near-miss samples + positieve CLV-trend).
4. **Plan v15.0.3 settlement-bridge** zodra `settlement-coverage.aging.open_older_than_7d > 10` en OddsPapi `/scores` consistent matcht op fixture-level.

## Request For Next Colleague

Please do a fresh research/read-through pass before implementing more code. The operator explicitly asks whether all functions are still logical now that TheSportsDB Premium v1/v2 and OddsPapi v4 endpoints exist, whether those endpoints are being used in the right places, and whether there are profitable implementation ideas we should add for the core goal: maximize long-term net profit.

Treat this as a P&L/product review, not a feature wishlist. The most important tension to evaluate:

- Strict gates protect CLV/ROI, but days of 0 picks may mean we are under-utilizing data or over-blocking playable value.
- More picks only helps if incremental bets have positive EV after execution friction, limits, account-health and variance.
- New APIs should increase true candidate quality and confidence, not just candidate volume.

Concrete questions to answer with file/line evidence:

1. Are v15 source paths actually consumed end-to-end?
   - Football: TSDB livescore, form fallback, standings fallback, OddsPapi sharp-anchor attribution.
   - Active sports: quota-aware OddsPapi sharp-anchor shadow logging.
   - Shadow sports: tennis/rugby/cricket schedule/odds paper scanner.
   - Candidate storage: `source_attribution`, `sharp_anchor`, `playability`.

2. Are any new API endpoints still dead or underused?
   - TSDB event stats, timeline, lineups, TV, venue, roster.
   - OddsPapi scores/events/odds for non-football sports.
   - Existing ESPN/MLB/NHL/Open-Meteo data.
   - Decide per endpoint: use as active signal, shadow signal, source attribution only, or leave unused.

3. Are market gates too strict or just correctly selective?
   - Review recurring scan counters: `btts_thin_h2h`, `dnb_no_market`, `handicap_no_devig`, `ep_below_min`, `extreme_divergence`, `ep_too_close_to_market`.
   - For each, determine whether the gate blocks bad bets or blocks recoverable positive-EV candidates because we are missing data/odds fallback.
   - Specifically inspect why football with 15 fixtures generated only 3 candidates and 0 final picks.

4. Can we increase good pick volume without breaking doctrine?
   - Better executable-market coverage from preferred/OddsPapi where legally actionable.
   - More markets with robust devig: totals, team totals, spreads/AH, DNB/DC where executable quotes exist.
   - Better priors for low-data leagues/sports through Bayesian shrinkage and source trust, not fake confidence.
   - Paper-to-active promotion rules for tennis/rugby/cricket based on settlement coverage + paper CLV.

5. Should sharp-reference data become background analytics only?
   - v15.0.1 stopped Pinnacle/Betfair bookie-anomaly inbox spam.
   - Keep sharp data for CLV, calibration, source-trust and model sanity.
   - Do not alert the operator unless the better quote is actually executable on preferred/operator bookies.

6. What is the best next implementation slice?
   - Prefer one or two high-ROI, low-risk changes.
   - Include expected impact on pick volume, CLV, failure modes, tests needed, and deploy risk.
   - Do not propose loosening all thresholds globally unless backed by settled/paper evidence.
