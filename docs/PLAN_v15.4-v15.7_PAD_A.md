# PLAN v15.4–v15.7 — Pad A (Edge-bewijs)

Datum: 2026-04-30
Auteur: Claude (Opus 4.7), na grill-sessie met Bart
Status: **v3 — Slice-readiness notificaties toegevoegd 2026-04-30, klaar voor `/ship v15.4`**
Volgt op: `docs/PRIVATE_OPERATING_MODEL.md` (geen wijziging op doctrine, alleen operationalisatie)

**Codex review samenvatting (2026-04-30):** Plan-richting akkoord, geen P0/P1 showstoppers. 5 hardening-aanscherpingen verwerkt in v2: (1) v15.5 als harde gate met v15.6-shadow-fallback, (2) v15.4 per-odds-bucket telemetrie + audit-script, (3) v15.6 anti-yo-yo formule concreter, (4) v15.7 unit-changes effective ≥24u vooraf, (5) Pad B carve-out alleen passief/administratief.

**v3 toevoeging (2026-04-30):** elke slice ship plant zelf een `slice_ready` operator_action notif voor de opvolger, zodra de gating-condities gehaald zijn. Operator hoeft de roadmap niet zelf bij te houden — de inbox zegt het.

---

## 1. Context

Op 2026-04-30 grill-sessie tussen Bart en Claude over de vraag of huidige systeem
de optimale methode is om netto bankrollgroei te maximaliseren. Uitkomst: huidige
v15-serie bouwde signal-expansion (TSDB-uitbreiding, expansion-shadow) zonder dat
de **fundering** stond. Specifiek:

- ROI laatste 18d = +2% over 65 bets — statistisch indistinguishable van break-even
- CLV-meting heeft onbetrouwbare bookie/market matching → feedback-lus kapot
- BTTS NO en NHL TT O/U bleven gespeeld worden ondanks degradatie → geen
  concept-drift-detectie
- High-odds picks zijn ongedempte variance-bommen
- Bankroll €256 (peak €320), unit €25 → 9,8% per unit = full-Kelly-territory
  bij onbewezen edge

**Conclusie:** Pad A (edge-bewijs) is verplicht **voor** Pad B (sharp-book
integratie + camouflage + harvest). Niet omdat €300/maand het doel is, maar
omdat zonder bewezen edge alle Pad B-werk fantasy-engineering is.

## 2. Strategische beslissing — Pad A vs Pad B

| | **Pad A — Edge-bewijs** | **Pad B — Scale & Harvest** |
|---|---|---|
| Doel | Bewijzen dat systeem structureel +3-5% ROI draait | €3000/maand harvest met sub-Kelly |
| Tijdshorizon | 4-6 maanden | Pas zinvol na Pad A done |
| Units | €10 op €500 BR | €100-1000 (afhankelijk van bookies) |
| Bookies | Huidige .nl-set | + Bet105, xbet, broker (Pinnacle) |
| Camouflage | Niet nodig (units onder limit-radar) | Verplicht (round numbers, niet altijd peak prijs, recreatieve mengbets) |
| Effort | Low-touch, bestaande architectuur fixen | Account-management + multi-bookie-routing |

**Beslissing:** Pad A nu. Pad B-prep alleen als by-product van Pad A-werk
(alles in `lib/` modules zodat het later herbruikbaar is voor B).

**Rode-vlag-trigger:** na ≥200 bets met ROI <0% **én** CLV <+0,5% → fundamentele
model-herziening, **niet** doorbouwen. Triggert auto-notificatie naar Operator-inbox.

## 3. Doelfunctie en exit-criteria

**Doelfunctie:** maximaliseer E[log(BR)] = Kelly-growth. Picks worden geselecteerd
op verwachte Kelly-edge (`mkP` doet dit al). CLV is **post-hoc validator** dat
`ep` gekalibreerd is, niet pick-criterium.

**Exit-criteria voor Pad A — ALLE VIER moeten passeren:**

| Criterium | Drempel | Waarom |
|---|---|---|
| `n_settled` | ≥ 200 bets sinds CLV-fix-deploy (v15.5) | Statistisch CI versmalt genoeg om edge van variance te onderscheiden |
| `roi_pct` | ≥ +3% over die 200 | Half-Kelly-niveau bewijs, niet net-boven-nul |
| `clv_pct` | ≥ +1,5% met `match_rate ≥ 80%` | Echte feedback-lus, niet schatting met gaten |
| `drift_evidence` | Geen signaal/markt/sport met ≥3w negatieve CLV-trend zonder demote-trigger | Concept-drift-mechaniek werkt aantoonbaar |

**Implementatie:** `lib/pad-a-completion-evaluator.js` (gebouwd in v15.7), analoog
aan `lib/graduation-evaluator.js`. Daily run, post naar Operator-inbox.

## 4. Bankroll & unit

**Beslissing:** BR naar €500, unit naar €10. Math: €10 / €500 = 2% per unit =
half-Kelly bij 4% true edge / kwart-Kelly bij 8% true edge.

**Beslissing Bart 2026-04-30:** Optie A — €244 bijstorten, BR naar €500.

→ Systeem ziet €500 BR vanaf v15.4-deploy. Drawdown-triggers werken correct
(`drawdown_soft` op -20% = €400, `drawdown_hard` op -30% = €350). Unit €10
= 2% per unit = half-Kelly bij 4% true edge / kwart-Kelly bij 8% true edge.

> Optie B (reserve-mentaal + top-up-rule) was de tweede mogelijkheid maar is
> verworpen omdat het stake-regime daardoor te conservatief zou triggeren.

**Schaal-up regels (v15.7 controller doet dit automatisch):**

| Fase | Trigger | Unit | % BR |
|---|---|---|---|
| Diagnose (nu) | Default | €10 | 2% |
| Edge-bewezen | Pad A criteria gepasseerd | €15-20 | 3% |
| Scale-up | n≥500, ROI≥5%, +CLV stabiel 8w | €25-50 | 2,5-5% |
| Pad B-prep | Scale-up bewezen | Per-bookie variabel | n.v.t. (camouflage-modus) |

## 5. Slice roadmap

### 5.1 — v15.4 · Variance-bom-gate + Operator-inbox + Coverage-audit-log

**Scope:**
- High-odds-cap in `mkP` — picks met `odd > 3.0` krijgen lagere `kellyToUnits`-cap (max 0,5U) tenzij `ep × (odd-1)` > drempel
- Per-odds-bucket MIN_EP: `odd ≤ 2.0` → MIN_EP huidige; `odd 2.0-3.0` → MIN_EP +1pp; `odd > 3.0` → MIN_EP +2pp
- **Per-odds-bucket telemetrie (Codex finding #2):** `bets.odds_bucket` kolom (`low` ≤2.0, `mid` 2.0-3.0, `high` >3.0) bij write-time afgeleid uit execution_odd. Maakt retrospectieve per-bucket queries mogelijk voor n, ROI, avg CLV, positive CLV rate. Zonder dit zijn de +1pp/+2pp drempels educated guesses zonder feedback-lus.
- **Retrospectieve audit-script `scripts/odds-bucket-audit.js`:** outputs per bucket {n, ROI%, avg CLV%, positive CLV rate} over rolling 30/90/365d. Operator runt maandelijks of bij twijfel over drempels.
- Operator-inbox: nieuwe filter `category='operator'` op bestaande notifications-tabel
- Coverage-audit-job: dagelijks tellen welke van 64 ligas in laatste 90d picks produceerden, log naar Operator-inbox als read-only insight (geen actie)
- **Slice-readiness scheduler voor v15.5:** dagelijkse check; zodra v15.4 ≥7d in productie staat én geen kritische errors in scan-log → post `operator_action` notif: *"v15.5 ready to ship · trigger `/ship v15.5`"*

**Files (verwacht):**
- `lib/picks.js` — variance-cap in `mkP` factory + `oddsBucket()` helper
- `lib/notifications.js` — `category` veld + `sendOperatorNotification` helper
- `index.html` — Operator-tab in inbox-view
- `lib/jobs/coverage-audit.js` (NIEUW) — dagelijkse coverage-telling
- `lib/runtime/maintenance-schedulers.js` — coverage-audit scheduler
- `scripts/odds-bucket-audit.js` (NIEUW) — retrospectieve per-bucket stats
- Migraties: `notifications.category` kolom + `bets.odds_bucket` kolom (low/mid/high)

**Telemetrie:**
- `scanTelemetry.varianceGateBlocks` (per scan, gesplitst per bucket)
- `scanTelemetry.varianceGateCapped` (kelly verlaagd, gesplitst per bucket)
- `coverageAudit.dormantLeagues` (90d zonder picks)

**Tests:** ≥12 nieuwe — variance-gate boundaries, MIN_EP per bucket, Operator-notification routing, coverage-audit query, `oddsBucket()` boundary-cases (1.99/2.00/2.01 etc), audit-script output-format.

**DoD:** scan-log toont `🚧 variance-gate: blocked=L/M/H capped=L/M/H` regel; Operator-tab leeg of met coverage-insight; `node scripts/odds-bucket-audit.js` returnt structurele stats over 65-bet history; geen regressie in andere paden.

### 5.2 — v15.5 · CLV-meting overhaul

**Scope:**
- Bookie-naam normalisatie tussen execution-bookie en closing-line bookie (huidige mismatch-bron)
- Market-key normalisatie (BTTS variants, totals point-precisie, spreads)
- Closing-line snapshot: garantie dat snapshot binnen ±5min van kickoff staat
- Match-rate per `(sport, market, bookie)` bucket gelogd
- Operator-inbox: wekelijkse Pad-A-progress-notificatie met `n / 200`, ROI, CLV, match-rate
- **Slice-readiness scheduler voor v15.6:** dagelijkse check; zodra v15.5 ≥14d in productie staat én rolling 14d match-rate ≥80% → post `operator_action` notif: *"v15.6 ready to ship in active mode · trigger `/ship v15.6`"*. Als ≥14d in productie maar match-rate <80%: dagelijkse status-update *"v15.6 nog niet ready · match-rate X% · target 80% · ship in shadow-mode mogelijk via `/ship v15.6 --shadow`"*

**Files (verwacht):**
- `lib/clv.js` of equivalent (mogelijk nieuw, mogelijk uit `server.js` extracten)
- `lib/integrations/sources/oddspapi.js` — closing-line capture verstrakken
- `lib/runtime/maintenance-schedulers.js` — wekelijkse progress-job
- Migratie: `bets.clv_match_quality` kolom

**Telemetrie:**
- `clvAudit.matchRatePct` per scan (totaal + per bucket)
- `clvAudit.unmatchedReasons` (bookie-name / market-key / no-snapshot / late-snapshot)

**Tests:** ≥15 nieuwe — bookie-aliassen, market-key edge-cases, snapshot-timing, match-rate berekening.

**DoD:** match-rate over laatste 7d ≥80%; eerste wekelijkse Operator-notificatie geland; alle bestaande CLV-paden backwards-compatible.

**Validatie-window:** 14 dagen na deploy soak voordat v15.6 mag starten.

### 5.3 — v15.6 · Drift-detectie + auto-demote

**Vereist (Codex finding #1 — harde gate):**
- v15.5 in productie ≥14d
- **AND** rolling 14d match-rate ≥80%
- Bij niet-gehaald: v15.6 ship in **shadow/read-only mode** — drift-detector evalueert + logt naar Operator-inbox als `coverage_insight`, maar voert **geen** demote-actie uit. Operator activeert handmatig via `POST /api/admin/v2/drift-detector/activate` zodra match-rate-target gehaald is.
- Reden: drift-detect op kapotte CLV-input produceert false demotes die echte signalen wegmaaien.

**Scope:**
- Per `(signal × market × sport × league)`: rolling 4w CLV-trend
- **Auto-demote-trigger (Codex finding #3 — concretere formule):**
  - Sample-eis: `n ≥ 30 over 21d` **OF** `n ≥ 10/week × 3 opeenvolgende weken`
  - CLV-eis: gemiddelde CLV ≤0% over die window
  - Severity-formule: CLV ≤ -2,0% → naar `shadow` (weight=0); -2,0% < CLV ≤ 0% → weight halveren
- **Anti-yo-yo re-promote-cooldown (Codex finding #3):**
  - Na demote: minimaal **28d cooldown** voor re-promote-evaluatie
  - Re-promote eis: positieve CLV op **nieuwe** sample (n ≥ 30 sinds demote-moment), niet historische data
  - Hergebruikt 6-dim graduation-evaluator (`lib/graduation-evaluator.js`) op de nieuwe sample
- Dezelfde mechanic uitgebreid voor **leagues** (niet alleen signalen) — low-CLV ligas krijgen lagere effective-edge-multiplier
- Operator-inbox: real-time demote-events + wekelijkse drift-summary
- Doctrine-update: `lib/signal-weights.js` krijgt `demoted` field naast `shadow`, met `demoted_at` timestamp voor cooldown-berekening
- **Slice-readiness scheduler voor v15.7:** dagelijkse check; zodra v15.6 ≥21d in productie staat én ≥1 succesvolle drift-evaluatie geland → post `operator_action` notif: *"v15.7 ready to ship · trigger `/ship v15.7`"*

**Files (verwacht):**
- `lib/drift-detector.js` (NIEUW) — pure helper, bevat sample-eis + severity-formule + cooldown-check
- `lib/signal-weights.js` — `demoted` + `demoted_at` state
- `lib/runtime/maintenance-schedulers.js` — drift-detect dagelijks
- `lib/routes/admin-inspect.js` — `POST /api/admin/v2/drift-detector/activate` endpoint
- Migratie: `signal_calibration.demoted_at` + `signal_calibration.demote_severity` + `league_calibration` tabel

**Telemetrie:**
- `driftDetector.mode` (`active` | `shadow`)
- `driftDetector.evaluatedBuckets` (totaal, demoted, halved, healthy, in-cooldown)
- `scanTelemetry.demotedSignalsBlocked` (picks niet gemaakt door demote)

**Tests:** ≥22 nieuwe — sample-eis boundaries (n=29 vs 30 over 21d, n=9 vs 10/week × 3w), severity-formule split (CLV=-1,99% vs -2,01%), cooldown-respect (poging tot re-promote dag 27 vs 28), shadow-mode-fallback bij match-rate <80%, league-level demote, BTTS-NO historische regressie.

**DoD:** historische test op BTTS-NO data laat zien dat het signaal automatisch gedemot zou zijn ná 3w met CLV<0 én n≥10/week; eerste live-demote OF eerste shadow-mode-evaluation geland naar Operator-inbox; activate-endpoint manueel getest.

### 5.4 — v15.7 · Phase-controller + unit-controller + data-source ROI audit

**Vereist:** v15.6 in productie ≥21d.

**Scope:**
- `lib/pad-a-completion-evaluator.js` — daily check op 4 exit-criteria (zie §3)
- `lib/unit-size-controller.js` — automatische unit-aanpassing op basis van fase + ROI/CLV trend (geen handmatige config meer)
- **Unit-change pre-announce window (Codex finding #4):**
  - Geen stille midden-op-de-dag-sprongen. Een unit-change die vandaag wordt geëvalueerd wordt **effective vanaf de eerstvolgende 00:00 Amsterdam ná ≥24u**. Dus: trigger om 14:00 dinsdag → effective 00:00 donderdag.
  - Bij trigger: `unit_change_pending` notificatie naar Operator-inbox met oude → nieuwe unit + reden + effective-timestamp
  - Bij effective-moment: `unit_change` notificatie + actuele unit-state-update
  - Operator kan via `POST /api/admin/v2/unit-change/cancel-pending` een geplande change annuleren binnen het 24u-window (escape-hatch)
- **Anti-flap-yo-yo voor unit-controller:** unit kan niet binnen 14d twee maal van richting wisselen (omhoog dan omlaag of vice versa)
- **Pad-A-completion notificatie:** `pad-a-completion-evaluator` post `operator_action` zodra alle 4 exit-criteria (zie §3) tegelijk voldaan zijn: *"Pad A done · ROI X% · CLV Y% · n=N · tijd voor Pad B-prep · open Bet105 + 1xbet accounts (KYC + €50-100 storting)"*
- Data-source ROI audit: per TSDB-endpoint en per api-sports-call meten welke fractie van picks die het feed-de uiteindelijk +CLV had → "dead weight" sources naar shadow
- Operator-inbox: phase-progress wekelijks, unit-change-pending + unit-change real-time, data-source-audit maandelijks
- Beslis-input voor: OddsPapi paid-tier upgrade ($30-50/mo) ja/nee, TSDB-endpoint snoei

**Files (verwacht):**
- `lib/pad-a-completion-evaluator.js` (NIEUW)
- `lib/unit-size-controller.js` (NIEUW) — bevat pre-announce + cancel-window logica
- `lib/jobs/data-source-roi-audit.js` (NIEUW)
- `lib/stake-regime.js` — integreer unit-controller (laag erbovenop, niet vervangen — bestaande regime-math blijft canoniek)
- `lib/routes/admin-inspect.js` — `cancel-pending` endpoint
- Migratie: `bankroll_state.phase` + `bankroll_state.unit_history` JSONB + `bankroll_state.pending_unit_change` JSONB

**Telemetrie:**
- `phaseController.currentPhase` + `criteriaProgress` JSON
- `unitController.lastChange` + reden + effectiveAt
- `unitController.pendingChange` (indien aanwezig)
- `sourceRoi.byEndpoint` JSON

**Tests:** ≥28 nieuwe — phase-transition boundaries (alle 4 criteria), unit-controller per fase, pre-announce-window edge-cases (trigger 23:59 vs 00:01, cancel binnen window, effective-moment exact), anti-flap-yo-yo (omhoog dan omlaag binnen 14d geblokkeerd), data-source-audit query-correctness.

**DoD:** Operator-inbox toont "Pad A: X/200 op koers" wekelijks; eerste `unit_change_pending` notificatie geland (niet stille direct-sprong); eerste data-source-audit toont concrete snoei-kandidaten.

## 6. Operator-inbox spec

**Doel:** alles wat Bart moet weten of doen verschijnt hier. Niets erbuiten.
Vervangt mentale TODO-lijst.

**Categorieën** (`notifications.category`):

| Categorie | Voorbeeld | Frequentie |
|---|---|---|
| `operator_action` | "Storten €244 nu BR-target wijzigt" / "v15.5 ready to ship · trigger `/ship v15.5`" / "Pad A done · open Bet105 + 1xbet accounts" | Per event |
| `phase_progress` | "Pad A: 47/200 bets · ROI +3,2% · CLV +1,1% @ 64% match" | Wekelijks |
| `auto_promotion` | "Signaal X graduated (NHL/totals) · weight 0→0,5" | Per event |
| `auto_demotion` | "BTTS-NO gedemot in NHL · 3w CLV-2,1%" | Per event |
| `unit_change` | "Unit €10→€12 vanaf morgen wegens 3w +CLV trend" | Per event |
| `red_flag` | "ROI -1,8% over laatste 50 bets · 150 bets nog tot rode-vlag-trigger" | Wanneer trigger ≤80% bereikt |
| `coverage_insight` | "12 van 64 ligas leverden 0 picks in 90d — overweeg snoei" | Maandelijks |
| `data_source_audit` | "TSDB-endpoint X: 0% +CLV-bijdrage · snoei-kandidaat" | Maandelijks |

**UI:** nieuwe filter-pill in bestaande inbox-view in `index.html`. Default-tab
voor Bart wordt `operator_*` (alle categorieën met die prefix).

**Webpush:** alleen `operator_action` en `red_flag` triggeren push (anders pushpump).
Rest verschijnt stil in inbox.

## 7. Activation contract

**Format:** `/ship v15.X — <korte beschrijving>`

**Wat ik dan doe (zonder verdere instructie):**
1. Lees dit plan-document + recente CHANGELOG (laatste 5 entries) + affected files per slice-spec
2. Implement scope per slice-definitie
3. Run `npm test` (moet ≥933 + nieuwe tests groen)
4. Run `npm run audit:high` (moet 0 vulns)
5. Bump versie in 6 plekken (`lib/app-meta.js`, `package.json`, `package-lock.json`, `index.html` 2x, `README.md`, `docs/PRIVATE_OPERATING_MODEL.md`)
6. Schrijf CHANGELOG-entry met aanleiding/added/changed/tests/verificatie
7. Commit met `[claude]` prefix + WHAT/WHY/IMPACT body
8. Push naar master
9. Stuur summary terug aan Bart met: wat geship, telemetry-line die in scan-log moet verschijnen, eventuele post-deploy actie (env-var, migratie)

**Audits per slice:**
- **Pre-ship:** tests + audit:high (in stap 3-4 hierboven)
- **In-slice:** scan-telemetrie expliciet geverifieerd (bewijst dat feature werkt)
- **Post-ship:** `/audit v15.X` na 7d soak — ik check of telemetry-doelwaarden gehaald zijn, post resultaat naar Operator-inbox

**Geen deploy in scan-windows:** 07:30 / 14:00 / 21:00 Amsterdam — ik check `new Date()` en wacht buiten die ramen.

## 8. Niet-doen-lijst (Pad A fase)

Wat we **niet** bouwen tot Pad A done is — **alleen code-werk**:

- Bet105 / xbet integratie (code)
- Camouflage-discipline (round-number stakes, mainstream-mengbets)
- Account-health stake-modifier
- Sharp-book broker integratie (Pinnacle via VPN/broker)
- Harvest-mode / withdrawal automation
- Multi-account stake-routing
- Nieuwe sporten (tennis/rugby/cricket blijven shadow)
- Nieuwe signal-types (alleen bestaande tunen)
- Frontend-cosmetica zonder operator-actie-relevantie

Argument: zie §2. Pad B-prep zonder bewezen Pad A is fantasy-engineering.

### Pad B carve-out — wel toegestaan (Codex finding #5)

**Passieve / administratieve voorbereiding** mag gewoon, want kost geen
code-tijd en geen scope-risico:

- Bet105 / xbet account aanmaken bij Bart, KYC doorlopen, eerste storting (zonder code-integratie nog)
- OddsPapi paid-tier prijs/coverage checken (informatief, beslissing volgt v15.7 audit)
- Broker-onderzoek (research, geen integratie)
- Notities bijhouden over wat in Pad B-fase gebouwd moet worden

Verschil: **research/admin = OK · code = niet OK**. Carve-out voorkomt dat we straks vanaf nul moeten beginnen met accounts, maar voorkomt ook scope creep in de codebase.

## 9. Aanvullende API/coverage werk

| Wanneer | Wat | Hoe |
|---|---|---|
| v15.4 | Coverage-audit (read-only) | Welke ligas leverden picks 90d, log Operator-insight |
| v15.6 | League-level demote | Drift-detector uitgebreid naar leagues, low-CLV ligas krijgen lagere multiplier |
| v15.7 | Data-source ROI audit | Per TSDB-endpoint + api-sports-call: bijdrage aan +CLV picks |
| v15.7 | OddsPapi paid-tier ja/nee | Beslissing op v15.2.0 telemetry + match-rate-data uit v15.5 |
| Post-Pad-A | Sport-coverage cull | Pas wanneer Pad A done — wellicht ligas of sporten cullen die structureel -CLV |

Bart hoeft hiervoor geen aparte slice te triggeren. Wordt automatisch
opgepakt in v15.6/v15.7.

## 10. Open punten voor Codex review

Zie `docs/CODEX_REVIEW_REQUEST_PAD_A.md` voor specifieke vragen aan Codex per
sectie van dit plan. Codex' antwoorden worden in dit document teruggemerged
als doctrine-aanvulling of als revisie van slice-spec.

## 11. Acties voor Bart NU

1. **€244 bijstorten** → BR €256 → €500 (Optie A bevestigd 2026-04-30)
2. **Unit op €10** zetten in operator-config
3. **Lees dit plan-doc + CODEX_REVIEW_REQUEST_PAD_A.md**
4. **Optioneel:** paste CODEX_REVIEW_REQUEST in Codex-chat → antwoord terug aan Claude
5. **`/ship v15.4 — variance-bom-gate + operator-inbox + coverage-audit-log`** — Claude pakt het op
