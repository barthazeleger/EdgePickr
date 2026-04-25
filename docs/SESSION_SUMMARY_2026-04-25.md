# Sessie-summary 2026-04-25

**Scope:** v12.2.5 → v12.2.43 (39 commits, 1 migratie, 752 tests groen).

## Wat is geleverd

### Audit-roadmap (v12.2.5 → v12.2.24, vóór migratie)

| Audit-item | Versie | Resultaat |
|---|---|---|
| Acuut + F1-7 + D1-3 | v12.2.5-14 | Security + correctness gates + persistente schedulers |
| F4 single-source | v12.2.19 | `lib/market-keys.js` + drift-detection |
| D4 calib single-source | v12.2.20 | Supabase als primary, file fallback bij outage |
| R2 partial + R3 diag | v12.2.21 | bet↔pick join + `/admin/v2/model-brier` |
| R1 spike | v12.2.22 | `/admin/v2/devig-backtest` log-margin vs proportional |
| R4 alerts wiring | v12.2.23 | Auto-push 15min cron op execution-edge windows |
| R7 concurrency | v12.2.16 | Tests + fixture-resolver inflight dedup |
| F4 lite tests | v12.2.15 | Cross-consistency tests detectMarket ↔ marketKeyFromBetMarkt |

### Operator-feedback fixes (live signalen)

| Versie | Fix |
|---|---|
| v12.2.25 | Hockey 2-way ML label krijgt `(inc-OT)` scope-marker |
| v12.2.26 | Extreme-divergence hard-drop (was alleen dampen) |
| v12.2.29 | Gelogd UI badge precieze matching (open + line-match) |
| v12.2.31 | Drempel 25pp → 20pp (Bart's Dallas TT 2.5 case) |
| v12.2.34 | UI sortering op `kelly` ipv `expectedEur` |

### Post-migratie (v12.2.27 → v12.2.43)

| Versie | Onderwerp |
|---|---|
| v12.2.27 | Calibration-monitor canonical wire-up (migratie ✓) |
| v12.2.28 | F5 calibration-bucket separation |
| v12.2.30 | `/admin/v2/scan-by-sport` endpoint |
| v12.2.32-33 | v2 totals coverage rollout (hockey TT/O/U + voetbal/MLB/F5) |
| v12.2.36 | `/admin/v2/concept-drift` endpoint |
| v12.2.37 | NBA + NFL + handball O/U → v2 |
| v12.2.38 | BTTS → v2 |
| v12.2.39 | `docs/ADMIN_ENDPOINTS.md` operator quick reference |
| v12.2.40-43 | Integration tests voor alle 5 nieuwe admin endpoints + 1 shape-fix |

## Operator quick-reference

Zie `docs/ADMIN_ENDPOINTS.md` voor alle endpoints. Voor de 14-dagen check-list: zie `docs/AUDIT_v12.2.23_FRESH_EYES.md` sectie 5.

### Meest impactvolle wijzigingen voor volgende scan

1. **20pp extreme-divergence drop** — picks zoals Dallas TT 2.5 (84% model vs 60% markt zonder signal-attribution) worden nu hard gedropt.
2. **UI sortering op kelly** — schone confident picks bovenaan; gedampende high-edge picks onderaan.
3. **Gelogd UI fix** — geen false positives meer.
4. **F5 bucket separation** — main O/U calibratie wordt niet meer vervuild door F5-resultaten.
5. **Hockey label `(inc-OT)`** — minder verwarring met 60-min regulation product op andere bookies.

## Status

- **Geen open P0/P1.**
- **Audit + memory-backlog volledig afgewerkt** of expliciet held met triggers.
- **Resterend deferred** (alle drie: bewuste sprint-keuze, geen blocker):
  - R5 live betting (wacht op pre-match Brier < 0.22 + CLV > +2% over 200 settled)
  - R6 paid sports API (budget-beslissing)
  - R8 server.js refactor (volgende sprint, alleen wanneer feature-werk te zwaar voelt)
- **Wachten op live data:**
  - R1 swap (default devig) — run `/admin/v2/devig-backtest` wekelijks
  - R2 isotonic-fit — wacht op ≥100 joined bets
  - R3 Bayesian dynamic strength — wacht op model-Brier vs market-Brier head-to-head ≥30 settled

## Tests

- **752 passed, 0 failed**
- Integration coverage voor alle 5 nieuwe admin endpoints
- Helper-coverage voor recordTotalsEvaluation, recordBttsEvaluation
- Concurrency tests voor F1/F2/F3 fixes

## Migraties

Alleen `v12.2.27_signal_calibration_source_unique.sql` — handmatig gedraaid in Supabase SQL Editor. Geen verdere migraties vereist.

## Volgende sessie-suggesties

1. **Live scan + observeer** — operator vergelijkt picks met pre-v12.2.27 baseline.
2. **Run dashboards** — `/admin/v2/scan-by-sport`, `/admin/v2/sharp-soft-windows`, `/admin/v2/model-brier` na 7 dagen.
3. **Threeway/DC v2** — als operator BTTS/threeway data wil zien in v2 dashboards.
4. **Brier-coverage breakdown** — UX op `/admin/v2/model-brier` voor "waarom geen join" inzicht.
5. **R8 sprint** — wanneer nieuwe feature-werk substantieel zwaar voelt door global state in server.js.
