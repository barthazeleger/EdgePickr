# EdgePickr v15.3.0 → v15.4.x Handoff voor Codex

Started: 2026-04-30 (post 22:00 NL, Claude full-build sessie)
Owner: Codex (review code + substantieve ontwerp-keuzes)
Base: v15.2.1 (`62b0d6b`) → **v15.3.0**

---

## Wat ik heb gebouwd (zonder verkort)

### Expansion shadow-write
- **`server.js`** in de bestaande Build E discovery-block (~regel 7820): wanneer `TSDB_EXPANSION_SHADOW=1`, voor max 50 expansion-fixtures een snapshot+model_run+pick_candidate schrijven met `passed_filters=false`, `rejected_reason='expansion_shadow_paper'`, `fixture_id=tsdb_event_id`. Vereist Pinnacle/Betfair quote in pre-loaded OddsPapi.
- **Telemetry** in scan-log: `expansion=N/M leagues · shadow_written=K` + apart `🔭 Expansion-shadow: N written · X skip(no sharp) · Y skip(no odds) · Z skip(parse)`.

### TSDB-backed settlement
- **`lib/integrations/sources/thesportsdb.js`**: nieuwe `fetchEventDetail(eventId)` (lookupevent.php) returnt `{homeTeam, awayTeam, homeScore, awayScore, isFinished, status}`. Cached short=30min voor live, week=7d voor finished.
- **`lib/paper-trading.js`**: nieuwe `runExpansionShadowSweep` analoog aan bestaande `runPaperTradingSweep`, maar dependency-injected fetch via TSDB en specifiek voor `rejected_reason='expansion_shadow_paper'` rows. Hergebruikt bestaande `settlePaperTradingCandidate` voor CLV.

### Graduation evaluator
- **`lib/graduation-evaluator.js`** (NIEUW, pure helper): 6-dim gates (n / avg_clv / roi / positive_clv_rate / preferred_coverage / recent_n). Alle 6 moeten passen. Anti-BTTS-bug: high-n + losses kan NIET passeren (avg_clv + roi gates blokkeren).
- **`/api/admin/v2/expansion-graduation-candidates`**: hergebruikt helper, toont per-liga `checks` object met value+threshold+pass per gate, plus `missing_gates` lijst.

### Auto-notification
- **`lib/runtime/maintenance-schedulers.js`**: nieuwe scheduler +180min na boot draait dagelijks de evaluator. Voor élke nieuwe ready-liga (niet eerder genotified) → notification `type='expansion_graduation_ready'` insert + dedup via `calib.graduation_notified` array.

### Operator quickstart
- **`docs/OPERATOR_QUICKSTART.md`** (NIEUW): live-updated bondig overzicht. Bart kan zien wat draait, welke env-flags hij moet zetten, welke endpoints te checken, hoe een graduation-ready liga toe te voegen.

### Versie & docs
- v15.2.1 → **v15.3.0** op alle pins.
- CHANGELOG.md uitgebreide entry.
- 933/933 tests groen (+8 nieuwe gradutaion + sweep tests).
- 0 vulnerabilities.

---

## Open ontwerp-vragen voor Codex (expliciet uitgenodigd om push-back te geven)

### 1. Doctrine: shadow-everything zonder filter
Ik heb GEEN risk-list/blacklist gebouwd ondanks dat sommige expansion-leagues (Georgian Liga 3, Zambia Super League, etc.) bekende match-fixing risico's hebben. Mijn argument: CLV is fix-resistant (Pinnacle's closing line absorbs fix-knowledge), dus shadow-data uit fixed-leagues is niet schadelijk — die produceren CLV-noise rond 0%, niet false positives.

**Codex moet beoordelen:**
- Is dit argument empirisch correct? Academisch werk over "Pinnacle bias op exotische 3e divisies" suggereert dat sharp-anchor zelf kan falen wanneer geen sharp-money de markt corrigeert.
- Moeten we toch een minimum-bookie-coverage gate VÓÓR shadow-write zetten (bv. <2 sharp-quotes = skip)?
- Is een eenmalige FIFA/UEFA blacklist-pull als initiele filter het waard?

### 2. Graduation-thresholds (anti-BTTS-bug)
Mijn 6-dim gates:
- n ≥ 30
- avg_clv_pct ≥ +0.5%
- roi_pct ≥ -2%
- positive_clv_rate ≥ 50%
- preferred_bookie_coverage ≥ 50% (≥3 bookies)
- recent_n ≥ 20

**Codex moet:**
- Stress-testen of deze drempels samen voldoende rigid zijn. Met name `positive_clv_rate ≥ 50%` + `roi_pct ≥ -2%` simultaan: vermijden we coverage-noise (high-edge winners offset door losses) die als cargo-culted positive signal langskomt?
- Beargumenteren of `min_avg_clv_pct=0.5` te streng of te ruim is. Lager = meer false positives. Hoger = ware kandidaten worden gemist.
- Beslissen of 8w window (totaal) + 4w recent-cutoff de juiste verhouding is.

### 3. Auto-promotie (deliberaat NIET gebouwd)
Operator wil zo min mogelijk zelf doen, maar ik heb NIET auto-promote naar `AF_FOOTBALL_LEAGUES` ingebouwd. Reden: TSDB-leagueName ↔ api-sports-league-id mapping is niet automatisch resolveable. Operator moet `/leagues?search=<name>` raadplegen en handmatig één regel toevoegen.

**Codex moet beslissen:**
- Bouwen we een TSDB→api-sports league-id mapping-tabel als persistent calib? Met automated lookup via api-sports `/leagues?search=` voor unknown leagues?
- Of houden we manual graduation als veiligheidsklep voor doctrine-naleving?

### 4. Auto-demotie (niet gebouwd)
Ready-leagues kunnen real-money picks beginnen. Maar als die degraderen (real-money avg_clv valt < 0% over n≥30), moet de liga terug naar shadow.

**Codex moet:**
- Ontwerpen welke real-money tracking dit triggert. Huidige paper-trading sweep is voor pick_candidates met shadow=true; auto-demotie vereist tracking van NA-graduation real-money picks (anders een aparte counter).
- Specificeren of dit een snelle fail (n=30, avg_clv<-2% in 4w) of langzame fail (n=100, avg_clv<-0.5% in 8w) moet zijn.

### 5. Market-multiplier auto-promotie (BTTS-bug regio)
Operator herinnerde aan v14 BTTS-bug: multiplier ging omhoog op high-n ondanks losses. Mijn graduation-evaluator codeert anti-BTTS-bug pattern voor LEAGUES, maar de bestaande `learning-loop.js` / `lib/calibration-store.js` autotune voor MARKETS is ongewijzigd.

**Codex moet REVIEWEN voordat nieuwe markt-promotie features landen:**
- Heeft de bestaande markt-multiplier autotune dezelfde single-metric bias als v14 BTTS-bug?
- Welke gates ontbreken die we voor leagues nu wel hebben?
- Is een market-graduation-evaluator helper analoog aan league-graduation een goede volgende slice?

Niet vóór deze review nieuwe market-promotion code mergen.

### 6. CLV match-fixing-resistance — empirisch toetsen
Mijn argument bij vraag 1 leunt op aanname dat Pinnacle CLV ↔ match-fixing-detection. Bekend academisch werk:
- Forrest, Goddard (2018) "Sportradar TruScores": Pinnacle bias bij thin markets
- Caillaut & Guegan (2020): Pinnacle handles spot fixes maar mist netwerk-fixes

**Codex moet:**
- Eén of twee referentie-papers raadplegen + samenvatten of mijn aanname stand houdt.
- Indien NIET: alternatief signaal voorstellen (bv. odds-volatility variance per leg).

### 7. OddsPapi free-tier sufficiency
Build A (v15.2.0) verhoogde OddsPapi-cap 2→5/scan met multi-bookie. Free-tier is 250/maand. 5/scan × 3 scans/dag × 30 dagen = 450 → over budget na ~2 weken. Adapter blokkeert fail-soft bij `usage.remaining ≤ 25` maar dat is reactief.

**Codex moet:**
- Empirisch checken na 7 dagen of we daadwerkelijk over de 250/maand gaan, OF dat lege-scan-dagen het verbruik onder de limit houden.
- Als over: is `ODDSPAPI_SHARP_CALL_CAP` terugzetten naar 3 + paid-tier upgrade ($30-50/mo) operator-voorstel beter dan budget-stress?

### 8. Schema-keuze
Ik schrijf shadow-rows in bestaande `pick_candidates` tabel met `shadow=true` + `rejected_reason='expansion_shadow_paper'`. Codex kan beargumenteren of een aparte `expansion_shadow_bets` tabel cleaner is voor:
- Querying performance (huidige WHERE rejected_reason filter scant volledige pick_candidates)
- Indexering
- Schema-evolutie (bv. expansion-specifieke velden zonder pick_candidates te bloaten)

Beslissing voor v15.4.0: hergebruiken (huidig) of split?

---

## Verificatie-checklist voor jouw eerste review

- [ ] `npm test` → 933/933 groen.
- [ ] `node --check` op alle aangeraakte bestanden.
- [ ] `npm run audit:high` → 0 vulnerabilities.
- [ ] `lib/graduation-evaluator.js` review: doctrine-correct? Gates juist?
- [ ] `lib/paper-trading.js runExpansionShadowSweep` review: race-conditions in cursor-paging op TSDB-id strings?
- [ ] `server.js` shadow-write block (~regel 7900-8050): edge-cases bij missing fx.eventId, malformed timestamp parsing, sharp-anchor team-mismatch?
- [ ] `lib/runtime/maintenance-schedulers.js`: graduation scheduler dedupe-logic via calib persistent?
- [ ] `docs/OPERATOR_QUICKSTART.md`: alles wat operator moet doen helder?

---

## Critical files in deze release

- `server.js:6244+` (telemetry counters), `7820+` (expansion shadow-write block), `8015` (scan-log breakdown line)
- `lib/graduation-evaluator.js` (NIEUW)
- `lib/integrations/sources/thesportsdb.js:721+` (fetchEventDetail)
- `lib/paper-trading.js:267+` (runExpansionShadowSweep)
- `lib/runtime/maintenance-schedulers.js:585+` (expansion-sweep + graduation scheduler)
- `lib/routes/admin-inspect.js:418+` (expansion-graduation-candidates endpoint)
- `docs/OPERATOR_QUICKSTART.md` (NIEUW, live-updated)
- Versie pins: `lib/app-meta.js`, `package.json`, `package-lock.json`, `index.html`, `README.md`, `docs/PRIVATE_OPERATING_MODEL.md`, `test.js`
- `CHANGELOG.md` (volledige entry)
