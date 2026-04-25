# EdgePickr · Audit + Roadmap (v12.2.2 baseline)

**Datum:** 2026-04-25
**Aanleiding:** 0 picks op zaterdag 07:30 scan, ondanks 100en wedstrijden over 6 sporten. Bart vroeg om een grondige fresh-eyes audit + externe research naar SOTA verbeteringen.

Twee Explore-agents diagnostiseerden parallel: 0-picks root-cause kandidaten + 5-dimensionale audit (functional / security / data-integrity / performance / code quality). Externe research via WebSearch over Bayesian Poisson modeling, isotonic calibration en CLV-baselined learning.

---

## Executive summary

**Geen kritieke financial exploits**, maar:
- **3 P0/P1 data-integrity issues** (race-conditions in bookie-balance + calibration, market-key asymmetrie)
- **1 P0 availability-risico** (DoS via fixture-resolver)
- **2 P1 learning-data integrity issues** (preferred-bookie filter, unit_at_time fallback)
- **3 P3 performance/reliability hardening** (memory leaks, scheduler persistence)

Daarnaast: vier strategische roadmap-sporen (Pinnacle CLV, isotonic calibration, dynamic Bayesian, sharp-soft asymmetric) die direct aan het kerndoel "structureel de markt verslaan" bijdragen.

---

## Horizon 1 · ACUUT — diagnose 0-picks-zaterdag

**Doel:** root-cause vinden zonder gokken. Bart draait 3 admin-endpoints, deelt JSON, daarna gerichte fix.

### Top-3 hypotheses (ranked)

| # | Kans | Hypothese | Bewijs |
|---|------|-----------|--------|
| 1 | 85% | **Cap-filter regressie (v12.1.11)** — `bestFromArr({maxPrice})` returnt `{price:0}` als preferred-pool helemaal leeg is na cap-filter. Edge wordt -100% → silent drop. | `pick-candidates-summary.byReason.no_bookie_price` of `price_too_high` zou hoog moeten zijn. |
| 2 | 65% | **Hockey TT scope-filter (v12.1.12)** — als api-sports `bet.name` met "Regular Time" stuurt, filtert `scope==='regulation'`-check ALLE Bet365 TT eruit. | Hockey-only effect. Voetbal/NBA/MLB ook 0 → niet deze. |
| 3 | 55% | **Cumulative strength + sigCount=0 + divergence cascade** — sigCount=0 silent rejects bovenop adaptiveMinEdge stijging bij dunne samples. | `pick-candidates-summary.byReason.edge_below_min` zou dominant zijn. |

### Acuut-actie

1. Bart draait browser-console snippet (zelfde als vorige diagnostic-sessie) → deelt JSON van 3 endpoints.
2. Match output tegen ranked hypotheses → fix scope:
   - **Hyp 1**: fallback `requirePreferred=false` als preferredBest.price === 0 (gedempte stake), of remove maxPrice voor 1 sport als A/B-test.
   - **Hyp 2**: minder strenge scope-check — alleen droppen als bookie ook in 60-min blacklist staat.
   - **Hyp 3**: tijdelijk MIN_CONFIDENCE 0.015 → 0.010 + sigCount=0 fallback met dataConf=0.20.

---

## Horizon 2 · QUICK WINS — top P0/P1 fixes

ROI-volgorde, klein-tot-medium effort.

### F1. [P0] Rate-limit & cache fixture-resolver fallback
- **Waar:** `lib/routes/bets-write.js` (`resolveFixtureIdForBet`)
- **Issue:** elke bet-create zonder fixture_id triggert N Supabase queries. Bulk-loop kan Supabase-quota uitputten.
- **Fix:** in-memory LRU cache (30 min TTL, key=`sport|datum|wedstrijd`) + per-user resolver-rate-limit (10/min).
- **Effort:** ~30 min.

### F2. [P1] Bookie-balance applyDelta atomic via Postgres RPC
- **Waar:** `lib/bookie-balances.js` (`applyDelta`)
- **Issue:** read-calc-write is non-atomic. Twee concurrent W-outcomes op zelfde bookie kunnen de tweede update verliezen. Direct geld-impact.
- **Fix:** Supabase RPC `increment_balance(user_id, bookie, delta)` met Postgres `UPDATE ... SET balance = balance + $delta` (atomic).
- **Effort:** 1 SQL-functie + RPC-call wrapper. ~45 min + migratie.

### F3. [P1] Calibration revert+update niet-atomair
- **Waar:** `lib/bets-data.js` (`updateBetOutcome`)
- **Issue:** outcome-flip W→L doet `revertCalibration` + `updateCalibration`. Als update halverwege exception → calib half-reverted, totalSettled telt fout.
- **Fix:** snapshot calib pre-flip → restore-on-exception. Of: één gecombineerde `flipCalibration(prev, new)` functie die alleen écht doorvoert na success.
- **Effort:** ~30 min.

### F4. [P1] Market-key asymmetrie tussen clv-match en learning-loop
- **Waar:** `lib/clv-match.js` (`marketKeyFromBetMarkt`) vs `lib/learning-loop.js` (`detectMarket`)
- **Issue:** zelfde markt mapt naar verschillende keys. CLV-feedback en calibratie raken ongesynced bij hybride markten (F5/1H).
- **Fix:** consolideer naar één `lib/market-keys.js` met canonieke `normalizeMarketKey(markt) → {canonical, clvShape, learningBucket}`. Geen behavior change, alleen single-source.
- **Effort:** ~2 uur incl. tests.

### F5. [P1] Preferred-bookie filter sluit historische learning-data af
- **Waar:** `lib/learning-loop.js` (`isPreferredBookie(bet.tip)`)
- **Issue:** als operator preferred-set wijzigt, vallen historische bets uit andere bookies plotseling buiten de calibratie. 80 settled bets → 0 die nog tellen → cold-start.
- **Fix:** persisteer per bet `was_preferred_at_log_time` boolean in DB. Filter op die kolom ipv runtime-check. Backwards-compat: bestaande bets default true.
- **Effort:** 1 migratie + ~30 min code.

### F6. [P2] 2FA-codes naar Supabase (5 min TTL)
- **Waar:** `lib/routes/auth.js`
- **Issue:** Render restart of crash → alle actieve 2FA-sessies stuk.
- **Fix:** kleine `auth_codes` tabel met TTL-cleanup, of bestaande `notifications`-tabel hergebruiken met `type='auth_code'`.
- **Effort:** ~45 min.

### F7. [P2] Fix `current-odds` bookie-specific lookup
- **Waar:** `lib/routes/bets-write.js` (`/bets/:id/current-odds`)
- **Issue:** "Nu"-knop pakt highest preferred-bookie odd, niet de bookie van de bet zelf. Drift-percentage onjuist (zie Edmonton TT @ 1.97 Unibet vs 1.86 Bet365).
- **Fix:** match strict op `bet.tip` in dedupe; fallback met label "andere bookie".
- **Effort:** ~20 min.

---

## Horizon 3 · DATA-INTEGRITY HARDENING

### D1. [P3] In-memory schedulers persistent maken
`schedulePreKickoffCheck` + `scheduleCLVCheck` zijn `setTimeout`. Render free-tier spindown verliest pending. Fix: persist pending checks in tabel met `due_at`. Bij boot: rescheduulen. Effort: ~3 uur.

### D2. [P3] `unit_at_time` retroactief vullen
Legacy bets zonder `unit_at_time` krijgen fallback naar *current* `unitEur`. Bij unit-step-up vertekent dit historische winU/lossU. Fix: éénmalige migratie. Effort: ~2 uur.

### D3. [P3] `_scanKickoffByFixture` Map TTL
Onbewaakte memory growth bij langlopende processes. TTL-eviction (30d) of clear-on-scan-end. Effort: ~15 min.

### D4. [P3] Calibration-store dual-persist
File-write + Supabase-write zonder lock. Concurrent updates kunnen elkaar overschrijven. Fix: Supabase als single source of truth. Effort: ~1 uur.

---

## Horizon 4 · STRATEGISCHE ROADMAP

Externe state-of-the-art, ranked op directe bijdrage aan kerndoel.

### R1. Pinnacle als sharp-CLV anchor (al gedeeltelijk)
Recent literature bevestigt: Pinnacle closing line is canoniek de sharpest reference. Verbeteringen:
- Pin Pinnacle als *primaire* CLV-baseline (niet enkel secondary).
- Devigging via log-margin removal ipv proportioneel — marginaal preciezer.
- Aparte calibration-bucket per "soft-vs-sharp" CLV.
- **Spike**: 1 dag research + 1 dag implementeer log-margin devigger.

### R2. Isotonic regression voor ep_proxy → canonical
Calibration-monitor schrijft nu `probability_source='ep_proxy'`. Recent SOTA: isotonic regression op pick.ep vs realized hitrate per bucket. Vereist eerst bet↔pick join-laag (deferred item).
- **Spike**: 2 dagen research + 1 week implementatie.

### R3. Dynamic Bayesian team-strength (Macri-Demartino 2025)
Onze Poisson is statisch. SOTA gebruikt rolling Bayesian update met team-ranking als covariate. Hoge effort (~2 weken).
- **Beslispunt**: alleen als Brier op huidige model > 0.24. Anders niet de moeite.

### R4. Bookie-arbitrage / sharp-soft asymmetric strategy
Doctrine zegt al: Pinnacle/Betfair = sharp ref, Bet365/Unibet = execution. Versterken via per-bookie-cluster overround tracking + auto-alert bij gap > 4% met Pinnacle 30 min vóór kickoff.
- **Effort:** ~1 week. Hoge ROI als execution-edge nog onbenut potentieel heeft.

### R5. Live betting / in-play (lange termijn)
Huidige scanner is prematch. Live = ~10× churn, hogere bookie-margin. **Hold tot data-bewijs**: pre-match Brier < 0.22 én CLV > +2% over 200 settled.

### R6. Larger sports API (SofaScore / Opta / betsapi)
Concrete waarde: line-up tijden, xG, referee stats. Kostenvergelijking: betsapi ~€100/mnd is haalbaar startpunt.

### R7. Tests uitbreiden naar concurrency + outcome-flips
Audit-gat: geen tests voor concurrent writeBet, outcome-flip onder Supabase-latency, fixture-resolver fallback. ~3 uur, hoge defensieve ROI.

### R8. server.js refactor naar app-factory
12k regels — geleidelijk extraheren. Niet urgent, wel onderhoudsdebt. ~1 dag.

---

## Voorgestelde 3-week sprint

**Week 1:**
- Horizon 1 acuut (Bart-input → fix)
- F1 (rate-limit), F2 (atomic balance), F7 (current-odds bookie-match)

**Week 2:**
- F3 (calibration atomic), F4 (market-key consolidatie), F5 (preferred at log-time)
- D3 (Map TTL)

**Week 3:**
- F6 (2FA persist), D1 (scheduler persist), D2 (unit_at_time backfill), D4 (calib single-source)
- R1 spike (Pinnacle log-margin devig)

**Daarna:** R2 (isotonic), R4 (sharp-soft), R7 (test coverage), R8 (refactor) — per beslissing.

---

## Kritieke files

- `lib/routes/bets-write.js` — F1, F7
- `lib/bookie-balances.js` + nieuwe migratie — F2
- `lib/bets-data.js` — F3, D2
- `lib/clv-match.js`, `lib/learning-loop.js`, nieuwe `lib/market-keys.js` — F4
- `lib/learning-loop.js` + migratie — F5
- `lib/routes/auth.js` + nieuwe tabel — F6
- `server.js` — D1, D3
- `lib/calibration-store.js` — D4
- `lib/odds-parser.js` — R1

## Verification

- Fixes (F1–F7, D1–D4) → unit tests + integratie-test per fix. Test-suite 674 → ~700+ passed.
- 0-picks fix → manuele scan, verwacht ≥3 picks over 3+ sporten.
- R1 spike → walk-forward backtest oude vs nieuwe devig op laatste 100 bets.

## Rollback

Elke fix is geïsoleerd commit + version bump. Bij regressie: revert 1 commit, redeploy. Data-migraties D2 + F5 zijn destructief (UPDATE) — vóór run snapshot via `pg_dump bets`.

## Sources

- [Pinnacle: What is Closing Line Value?](https://www.pinnacle.com/betting-resources/en/educational/what-is-closing-line-value-clv-in-sports-betting)
- [Datagolf: How sharp are bookmakers?](https://datagolf.com/how-sharp-are-bookmakers)
- [arXiv: ML in Sports Betting systematic review (2024)](https://arxiv.org/html/2410.21484v1)
- [arXiv: Bayesian weighted dynamic models for football (Aug 2025)](https://arxiv.org/html/2508.05891v1)
- [R-bloggers: Bayesian sports betting systems (Feb 2026)](https://www.r-bloggers.com/2026/02/designing-sports-betting-systems-in-r-bayesian-probabilities-expected-value-and-kelly-logic/)
- [Macrì Demartino et al. 2025 — ranking-as-covariate](https://www.sciencedirect.com/science/article/abs/pii/S095741742600775X)
