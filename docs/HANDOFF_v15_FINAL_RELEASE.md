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
| Release cutover | Done | v15.0.0 pins, README, CHANGELOG, doctrine and info page refreshed; final checks passed. |

## Risks

- `server.js` is monolithic and scan-loop changes can be easy to under-test if only pure helpers are covered.
- OddsPapi quota is small on the free tier, so sharp-anchor calls must stay quota-aware and fail-soft.
- Tennis/Rugby/Cricket activation must remain shadow/paper until settlement coverage is proven.
- Migration is committed but not run automatically; deploy needs the documented migration command before v15 admin attribution readouts become fully populated.

## Verification Log

- 2026-04-28: `npm test` after the NFL scan fix passed with `876 passed / 0 failed`.
- 2026-04-28: `npm test` after runtime tunables + hierarchical signal resolver passed with `878 passed / 0 failed`.
- 2026-04-28: `npm test` after v15 data/admin surfaces passed with `878 passed / 0 failed`.
- 2026-04-28: `npm test` after scan-loop source wiring, anomaly expansion, and T/R/C shadow activation passed with `880 passed / 0 failed`.
- 2026-04-28: `node --check server.js lib/v15-runtime.js lib/signal-weights.js lib/snapshots.js` passed.
- 2026-04-28: `npm test` final release run passed with `880 passed / 0 failed`.
- 2026-04-28: `npm run test:coverage` passed with `880 passed / 0 failed` under c8; overall coverage `43.99%` because the monolithic `server.js` is not loaded by the unit harness.
- 2026-04-28: `npm run audit:high` passed with `0 vulnerabilities`.

## Next Exact Step

Commit and push v15.0.0 only in a safe Amsterdam scan window. After deploy: run `node scripts/migrate.js docs/migrations-archive/v15.0.0_pick_candidate_attribution.sql`, then `POST /api/admin/v2/rebuild-calib`.
