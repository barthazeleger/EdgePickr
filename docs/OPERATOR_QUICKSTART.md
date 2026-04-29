# EdgePickr Operator Quickstart

> **Doel van dit document:** alles wat jij (Bart) zelf moet doen om de tool optimaal te benutten. Korte versie, één scrollje. Wordt elke release vervangen.

Versie: **v15.3.1** · Laatste update: 2026-04-30

---

## 1. Wat draait automatisch (geen actie nodig)

| Wat | Wanneer | Resultaat |
|---|---|---|
| Pre-match scans | 07:30 / 14:00 / 21:00 NL | Picks in `/api/picks` |
| Multi-sport scans | Direct na voetbal | NHL/NBA/MLB/NFL/Handball |
| Shadow scans T/R/C | Direct na multi-sport | Paper-trade tennis/rugby/cricket |
| TSDB-discovery telemetry | Elke scan (env-flag aan) | `🔭 Expansion-discovery: N fixtures…` |
| **Expansion shadow-write** *(v15.3.0)* | Elke scan (env-flag aan) | Shadow pick_candidates voor wereldwijde voetbal-fixtures |
| Paper-trading sweep (api-sports) | +90min na boot, dagelijks | Settled paper-trade rows met CLV |
| **Expansion shadow sweep (TSDB)** *(v15.3.0)* | +150min na boot, dagelijks | Settled expansion-rows via TSDB scores |
| **Graduation evaluator** *(v15.3.0)* | +180min na boot, dagelijks | Notification wanneer liga 6/6 promotion-gates passeert |
| Calibration auto-tune | Continu via settle-callback | Multipliers updaten op nieuwe settled bets |

---

## 2. Env-flags op Render (zet deze aan)

Stand: 30 april 2026.

| Flag | Waarde | Status | Effect |
|---|---|---|---|
| `TSDB_API_KEY` | Premium key | ✅ | TSDB Premium endpoints + V2 livescore |
| `TSDB_LEAGUE_BASELINE` | `1` | ✅ | League scoring baseline → OU-prior signal |
| `TSDB_VENUE_EFFECT` | `1` | ✅ | Altitude/capacity venue-effect signal |
| `TSDB_LINEUP_STRENGTH` | `1` | ✅ | Pre-kickoff lineup-strength nudge |
| `TSDB_INJURY_VALIDATION` | `1` | ✅ | Cross-check api-sports vs TSDB roster |
| `TSDB_DISCOVERY_EXPANSION` | `1` | ✅ | Wereldwijde fixture-telemetry |
| `TSDB_EXPANSION_SHADOW` | `1` | ✅ aan sinds v15.3.0 | Schrijft shadow pick_candidates voor 50 expansion-fixtures/scan (vereist OddsPapi sharp match) |
| `TSDB_SETTLEMENT_ENRICHMENT` | `1` | ✅ | Settled bets verrijken met TSDB event-stats |
| `OPERATOR_PUSH_VAPID_*` | secret | ✅ | Web-push notificaties |

**Acties voor jou:**
- Zet `TSDB_EXPANSION_SHADOW=1` aan op Render → dat start vandaag de paper-data-collectie voor de 127 expansion-fixtures/dag. Zonder writes = geen graduation-data later.

---

## 3. Endpoints om dagelijks naar te kijken

Open in admin (`https://edgepickr.onrender.com/api/admin/v2/...`):

| Endpoint | Wat zie je | Wanneer kijken |
|---|---|---|
| `/pick-funnel?hours=24` | Waar candidates sneuvelen in de cascade | Elke dag |
| `/expansion-graduation-candidates` | Welke leagues 6/6 gates passeren | Wekelijks |
| `/settlement-coverage?probe=1` | Open bets + settlement-velocity | Wekelijks |
| `/clv-stats` | CLV per sport/markt | Wekelijks |
| `/tsdb-utilization` | TSDB-call-budget gebruikt | Maandelijks |
| `/conviction-doctrine` | Of conviction-route loosening aan moet blijven | Maandelijks |

---

## 4. Wat je inbox laat horen (notifications)

Push + inbox: alleen wanneer er échte actie nodig is.

| Type | Trigger | Wat doe jij? |
|---|---|---|
| `pick_published` | Nieuwe pick gegenereerd | Bekijken in app, plaatsen op preferred bookie |
| `expansion_graduation_ready` *(v15.3.0)* | Liga passeert alle 6 promotion-gates | Voeg liga toe aan `AF_FOOTBALL_LEAGUES` (zie sectie 5) |
| `upgrade_unit` | Bankroll +100% sinds start | Unit verhogen via Instellingen |
| `upgrade_api` | ROI > 10% over 30+ bets | Overweeg api-sports All Sports upgrade |
| `kill_switch_triggered` | Markt-bucket avg_clv < -5% over n≥30 | Niets doen — auto kill, evt review |
| `stake_regime_transition` | Bankroll-state shift (drawdown/peak) | Niets doen — automatisch |

**Sharp-reference bookies (Pinnacle/Betfair) firen GEEN bookie-anomaly meer** sinds v15.0.1.

---

## 5. Hoe een graduation-ready liga toevoegen

Wanneer je notification `🎓 Liga graduation-ready: <name>` krijgt:

1. Open `/api/admin/v2/expansion-graduation-candidates` → bekijk de stats voor die liga.
2. Resolve api-sports league.id manueel:
   - Ga naar `https://dashboard.api-football.com/soccer/leagues` of zoek via `https://v3.football.api-sports.io/leagues?search=<liga-naam>`.
   - Noteer het `league.id` (4-cijferig).
3. Voeg één regel toe aan `AF_FOOTBALL_LEAGUES` in `server.js`:
   ```js
   { id:XXX, key:'<slug>', name:'<naam>', ha:0.05, season:CURRENT_SEASON },
   ```
4. Bump versie (CHANGELOG.md, app-meta, package.json, package-lock.json, index.html × 2, README.md, docs/PRIVATE_OPERATING_MODEL.md, test.js release-test).
5. Push naar master. Render redeployt. Volgende scan pakt de liga op.

> Auto-promotion is niet gebouwd omdat TSDB-leagueName ↔ api-sports-league-id mapping niet betrouwbaar automatisch is. Codex kan dat later met een manuele lookup-table oplossen, maar evidence-driven promotion is dan nog steeds operator-keuze.

---

## 6. Niet-doen lijst (doctrine)

- ❌ Drempels (ep_gap / kelly / divergence) verlagen zonder CLV-bewijs uit settled bets
- ❌ Sport-promoties (T/R/C) zonder paper-trade graduation
- ❌ Liga's blind toevoegen aan `AF_FOOTBALL_LEAGUES` zonder graduation-pipeline
- ❌ Real-money picks op shadow-only sources
- ❌ Deploys in scan-windows (07:30 / 14:00 / 21:00 NL)

---

## 7. Wat doet Codex (review-loop)

Codex reviewt elke nieuwe Claude-release op:
- Code-correctness
- Doctrine-alignment (geen single-metric promotion, geen blinde uitbreiding)
- Substantieve ontwerp-keuzes (kun je het prepareren of moet het anders?)

Codex' veto-bevoegdheid is in `CLAUDE.md` vastgelegd. Open ontwerp-vragen per release staan in `docs/HANDOFF_v15.x.x_*.md`.

---

## 8. Quick troubleshoot

| Probleem | Check |
|---|---|
| `0/59 leagues actief` | Tijdvenster + speel-kalender. Niet automatisch een bug — TSDB-livescore + expansion-discovery laten zien of er wereldwijd wel fixtures zijn |
| `oddspapi=off` | Admin source-toggles. v15.0.4 fixt default-on bij eerste boot |
| Geen `🔭 Expansion-discovery` regel | `TSDB_DISCOVERY_EXPANSION=1` op Render staan? |
| `expansion=N/M` maar `shadow_written=0` | Check de `OddsPapi keys: ...` regel: `none-matched` = OddsPapi heeft geen coverage voor die specifieke expansion-leagues. Operator-actie: leagues met sample handmatig toevoegen aan SPORT_KEY_MAP in `lib/integrations/sources/oddspapi.js`, of paid-tier overwegen voor brede coverage |
| Geen graduation-notification ondanks veel shadow rows | Check `/api/admin/v2/expansion-graduation-candidates` → zie welke gates falen |
| Tests rood lokaal | `npm test` na `npm install`. CI is groen op master |
