# EdgePickr v15 Post-Deploy Handoff (Claude continuation)

Started: 2026-04-28 17:40 CEST
Owner: Claude (volgt op Codex' v15.0.0 release-handoff)
Base: v15.0.0 (`9655008`, op origin/master)
Voorganger-handoff: `docs/HANDOFF_v15_FINAL_RELEASE.md` (Codex)

## Status v15.0.0 (Codex' werk geverifieerd)

- ✅ v15.0.0 commit op origin/master (`9655008 [Codex] v15.0.0 final self-improving release`)
- ✅ Lokaal master = origin/master
- ✅ Tests passen (880 conform Codex' verification log)
- ✅ All system-reminder file-states bevestigen v15-changes (calib-params, calib-store, README, app-meta, oddspapi)
- ❌ Migration nog niet gerund (vereist operator-actie met laptop + .env)
- ❌ rebuild-calib nog niet aangeroepen (vereist operator-actie via curl/admin-cookie)

## Operator-acties (open)

1. **Run migration** (Codex' handoff sectie "Next Exact Step"):
   ```bash
   cd ~/projects/edgepickr
   node scripts/migrate.js docs/migrations-archive/v15.0.0_pick_candidate_attribution.sql
   ```
   Effect: `pick_candidates` schema krijgt `source_attribution`, `sharp_anchor`, `playability` kolommen.

2. **Run rebuild-calib**:
   ```bash
   curl -X POST https://edgepickr.com/api/admin/rebuild-calib \
     -H "Authorization: Bearer <ADMIN_JWT>"
   ```
   Effect: markets/leagues herrekend over admin settled-bets-history, BTTS-priors per sport gepopuleerd uit historie, NHL-OT-share gederiveerd, stale waardes weggewerkt.

## Wat er na operator-acties zichtbaar moet zijn

- `/api/status` toont per-source attribution-counts in pick_candidates
- Volgende scan logt `bookie_anomaly` notificaties voor uitgebreide markten (1X2/DC/OU/AH per Codex' Phase 6)
- Tennis/Rugby/Cricket draaien als shadow-scanners (paper-only, geen execution-impact)
- Hierarchical signal weights resolven via `sport:market:signal` → `sport:signal` → `signal`

## Wat ik (Claude) gevalideerd heb in deze continuation-sessie

- Git state: lokaal == origin op `9655008`, alleen `AGENTS.md` untracked (per Codex' note: laat staan)
- Migration-bestand bestaat: `docs/migrations-archive/v15.0.0_pick_candidate_attribution.sql`
- rebuild-calib endpoint actief: `lib/routes/admin-backfill.js:60` — `POST /api/admin/rebuild-calib`, `requireAdmin` middleware
- Geen pending uncommitted changes, geen verlopen merge-state

## Open punten voor volgende sessie (mij of Codex)

| Item | Bron | Status | Actie |
|------|------|--------|-------|
| Migration runnen | Codex' handoff | Pending | Operator |
| rebuild-calib runnen | Codex' handoff | Pending | Operator |
| Verify scan-output post-deploy toont source-attribution + bookie_anomaly | v15 doctrine | Pending | Volgende scan-cyclus |
| Stake-regime threshold backtest-tuning | v14 deferred | Open (data-driven) | Wacht op 200+ settled bets per regime |
| Pitcher-reliability + injury-weight calibration | v14 deferred | Open (data-driven) | Wacht op sport-specifieke historie |
| Phase B sharp-anchor (Pinnacle-only via OddsPapi) | v14 deferred | Open (economisch) | Operator-keuze paid-tier upgrade $20+/mnd |
| Concept-drift signal_calibration writer | v14 deferred | Open (architectuur) | Codex zou kunnen prioriteren |
| Daily auto-report cron | v14 deferred | Open (observability) | Lager-prio dan Phase B |

## Doctrine-richtsnoer (operator 2026-04-28)

> "alleen door data continu beter, geen code-changes voor parameter-tuning"
> "alles wat is weggelaten komt er later NOOIT meer in"

Implicatie: open punten hierboven zijn data-driven (komen vanzelf wanneer sample-size er is) of operator-economic (Phase B paid-tier). Geen verdere code-features op de hardware-roadmap; alle parameter-evolutie via calib.json.

## Verification checklist (post-deploy)

- [ ] `node scripts/migrate.js docs/migrations-archive/v15.0.0_pick_candidate_attribution.sql` exit 0
- [ ] `POST /api/admin/rebuild-calib` returns 200 + counts-summary
- [ ] Eerstvolgende scan-log toont `🔌 Scraper-health: thesportsdb=ok(...) · oddspapi=ok(...)` (al bevestigd in 14:00 + 16:00 scans)
- [ ] Eerste settled-bet post-deploy schrijft v15-source-attribution kolommen
- [ ] Een `bookie_anomaly` notificatie verschijnt voor minstens één pick (test op next scan met >1 pick)
- [ ] `/api/admin/v2/calib` toont `bttsPriors` met populated `n` + `lastUpdated` per sport (post rebuild-calib)
- [ ] Tennis/Rugby/Cricket scan-loop output verschijnt in scan-log als shadow-only

## Mocht ik (Claude) terug moeten

Lees in volgorde:
1. `docs/HANDOFF_v15_FINAL_RELEASE.md` (Codex' originele handoff)
2. Dit bestand (`HANDOFF_v15_POST_DEPLOY.md`)
3. `CHANGELOG.md` v15.0.0 entry voor scope-summary
4. `docs/PRIVATE_OPERATING_MODEL.md` v15-update sectie

Geen verdere code-werk planned tenzij operator expliciet uitvraagt of een data-driven trigger materializeert.
