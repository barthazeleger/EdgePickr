# EdgePickr v15.2.0 → v15.3.0 Handoff voor Codex

Started: 2026-04-30 (Claude implementation tijdens operator-slaap)
Owner: Codex (review + tuning)
Base: v15.0.13 (`bfa9323`) → **v15.2.0** (deze release)

## Wat ik heb gebouwd

### Build A — OddsPapi multi-bookie call (geactiveerd, geen flag)

**`server.js:6450-6489`**

`loadFootballSharpOdds()` haalt nu in één call:
- **Sharp anchor** bookies: `pinnacle,betfair,betfair_ex_eu,betfair_ex_uk` (CLV truth)
- **Execution** bookies: `bet365,unibet,toto,betcity,williamhill,bwin,1xbet`

Cap verhoogd 2→5/scan (kost ~5 OddsPapi-calls/scan × 3 scans × 30 dagen = 450/maand → past nét in free-tier 250/maand of nipt over). Adapter-quota-check (`usage.remaining <= 25`) blokkeert fail-soft als quota dreigt.

**Nieuwe scan-log regel:**
```
📡 OddsPapi bookies: pinnacle=N · bet365=M · unibet=K · toto=J · ...
```

**Codex review-vragen:**
1. Bevestig dat `summarizeSharpAnchor` (lib/v15-runtime.js:79) niet breekt door extra non-sharp bookies in `merged.quotes` — sharp-detection regex `/pinnacle|betfair|exchange|circa|sbobet/i` filtert sharp uit, andere quotes belanden onder `bestUnmatched`. Bekijk of operator's `🏦 Edge-evaluatie op jouw bookies` tooltip nu correcte cross-source data ontvangt.
2. Quota-cap. 5/scan × 3 scans/dag × 30 = 450/maand. Free-tier zegt 250. Kijk in `oddspapi.js getUsage()` of de remaining-counter daadwerkelijk degradeert vóór hard limit, of dat we in praktijk over de 250 pushen. Zo ja: heroverwegen op 3-cap, of operator paid-tier upgrade (~$30/mo).

### Build E v1 — TSDB-discovery telemetry (env-gated, default off)

**`server.js:7790-7860`**

Nieuwe env-flag `TSDB_DISCOVERY_EXPANSION=1` triggert na de 59-liga loop één TSDB `fetchSchedulesByDate` call (day-cached, dus effectief 0 extra calls). Filtert wereldwijde voetbal-fixtures op "niet in tracked-set" via `trackedAliases` set met substring-tolerance.

Pure observability v1: schrijft géén pick_candidates, doet géén mkP-calls, geen api-sports/odds calls. Telt alleen + emit one log line:
```
🔭 Expansion-discovery: 47 fixtures in 23 niet-tracked leagues · top-3: liga A (5), liga B (4), liga C (3)
```

Telemetry-counters: `expansionCandidates`, `expansionLeagues` in `scanTelemetry` + `🛰️ v15 sources` regel als `expansion=N/M leagues`.

**Codex review-vragen:**
1. Operator zal `TSDB_DISCOVERY_EXPANSION=1` toggelen op Render. Verifieer in eerste scan dat `🔭 Expansion-discovery` regel verschijnt en getallen zinvol zijn (typisch 30-100 fixtures op werkdagen).
2. Vergelijk de top-3 leagues over 5-7 scans. Zoek terugkerende leagues met hoge volume (bv. Indian ISL, MLS Next Pro, Brasileirao Série C). Dat zijn kandidaten voor v15.2.1 expansion-processing slice.
3. Tracked-aliases lijst (regel 7807-7811) is handmatig samengesteld uit huidige _resolveTsdbLeagueId. Check of er false-positives zijn (bv. een Liga Portugal 2-fixture die per ongeluk als 'Primeira Liga' wordt herkend). Substring-match `≥5 chars` vermijdt de meeste collisions.

## Wat NIET in deze release zit (voor jouw slice)

### Build B — TSDB-primary form (defer met data-driven onderbouwing)

**Waarom defer:** zonder Build A telemetry data weten we niet of TSDB form-events daadwerkelijk rijker zijn dan api-sports W/D/L letters voor de leagues die wij tracken. 7+ scans aan data verzamelen, dan beslissen.

**Voorgestelde implementatie als/wanneer:**
1. Nieuwe `formSummaryToStatsPrimary(baseStats, formSummary, teamId)` in `lib/v15-runtime.js` — TSDB values overschrijven api-sports waar TSDB heeft, anders api-sports houden.
2. In `server.js:6812+` env-flag check `process.env.TSDB_FORM_PRIMARY === '1'`:
   - Bij flag-on: pre-fetch TSDB form parallel met api-sports, gebruik `formSummaryToStatsPrimary`.
   - Bij flag-off: huidig gedrag (TSDB-fallback only).
3. Telemetry: `tsdbFormPrimaryWins` / `tsdbFormFallbackUsed`.

### Build C — TSDB-primary H2H (defer)

**Waarom defer:** identieke logica als B. H2H heeft minder volume per fixture dan form, dus marginaler. 

**Voorgestelde implementatie:**
1. Nieuwe env-flag `TSDB_H2H_PRIMARY=1`.
2. In de bestaande H2H-block (server.js, search `agg.getMergedH2H`): probeer TSDB eerst; als <3 events terug → api-sports H2H als fallback.
3. Verwacht effect: −10-15 api-sports calls/scan (uitgaande van 8 fixtures × ~1.5 H2H-call/fixture).

### Build F — OddsPapi als odds-fallback (couples met E v2)

**Waarom defer:** alleen relevant zodra Build E v2 expansion-fixtures probeert te processen. Voor non-tracked leagues hebben we nu géén api-sports `/odds`-call wiring; OddsPapi-fallback is alleen nodig wanneer api-sports geen bookmakers in payload heeft.

**Voorgestelde implementatie (in v15.2.1 met Build E v2 samen):**
1. Nieuwe helper `resolveExpansionOdds(fixture, oddspapiQuotes)` die OddsPapi-quotes filtert op team-name + kickoff-time match.
2. Returnt `{quotes, source: 'oddspapi'}` die kan worden gevoed aan een lichte versie van mkP.
3. Telemetry: `expansionOddsFromOddspapi` / `expansionOddsFromApiSports`.

### Build E v2 — Expansion processing (de echte coverage-uitbreiding)

**Doel:** voor elke expansion-fixture met odds, schrijf shadow pick_candidate (zoals `runShadowSports` voor tennis/rugby/cricket).

**Voorgestelde architectuur:**
1. Nieuwe helper `lib/runtime/scan-expansion.js` exporting `runFootballExpansionScan(deps)`.
2. Deps: `{supabase, snap, _currentModelVersionId, scanTelemetry, AF_FOOTBALL_LEAGUES, sourceAttributionBase, summarizeSharpAnchor, fetchV15SharpAnchorOdds}`.
3. Per expansion-fixture:
   - Pak best Pinnacle/Betfair quote uit pre-loaded sharp data
   - Bereken naïeve fairProb = 1/odds (geen model overlay)
   - Schrijf shadow pick_candidate met `passedFilters=false`, `rejectedReason='expansion_shadow'`
4. Cap 30 fixtures/scan, env-flag `TSDB_EXPANSION_SHADOW=1`.
5. Operator review: na 7 dagen → kies leagues met genoeg sharp coverage + sluitend CLV → graduate naar 60ste, 61ste, 62ste tracked-league via toevoeging aan `AF_FOOTBALL_LEAGUES`.

**Operator-instructie:** doe NIET tegelijkertijd Build B/C/F/E-v2. Stage ze:
- v15.2.0 ✅ (deze release)
- v15.2.1: Build B (TSDB-form-primary) — laagste risico, zichtbare CLV-impact in 1-2 weken
- v15.2.2: Build E v2 + F (expansion-processing + odds-fallback)
- v15.2.3: Build C (TSDB-H2H-primary) — kan misschien gecombineerd met v15.2.2

## Bekende open observaties

1. **Pre-mkP funnel `handicap_no_devig` op 100% van fixtures** (uit operator's recente scan-log). Dit is GEEN v15.2.0 issue, maar wel een productieve check voor jouw slice: kijk of de devig-helper voor handicap-markten een doctrine-niveau probleem heeft, of dat dit puur datum-coverage is in de huidige fixture-set.

2. **`oddspapi_quotes=0 · sharp_anchor_fixtures=0`** observed in early scans. Onderzoek na deze release: is dat een functie van OddsPapi geen-quotes-voor-deze-leagues, OF van team-name-matching die te streng is in `summarizeSharpAnchor` (regel 79+)? Build A multi-bookie zou meer raw quotes moeten leveren waardoor de matcher niet meer fail-soft op nul moet falen.

3. **`tsdb_inj_checks` reasons-buckets** (v15.0.13). Eerste scan-data zal tonen of de fuzzy-match-verbeteringen `name_unmatched` daadwerkelijk omlaag krijgen. Als > 50% van mismatches nog `name_unmatched` blijft na thin-roster filter, dan is de TSDB-roster-bron op exotische leagues echt onbruikbaar en kan operator overwegen `TSDB_INJURY_VALIDATION=0` te zetten.

## Veiligheidsklepjes

- Alle nieuwe paden achter env-flags. Default off voor `TSDB_DISCOVERY_EXPANSION`.
- Build A is altijd-aan want telemetry-only impact en geen quota-overschrijding bij default cap (5/scan, oude 2/scan was conservatief). Als jij na review denkt dat 5 te hoog is, draai `ODDSPAPI_SHARP_CALL_CAP` constante terug naar 2.
- Geen mkP-pad gewijzigd. Geen pick_candidate writes. Geen schema-changes.

## Verificatie-checklist voor jouw eerste review

- [ ] `npm test` → 925/925 groen (was 925/925 vóór mijn changes ook).
- [ ] `node --check server.js` schoon.
- [ ] `npm run audit:high` → 0 vulnerabilities.
- [ ] Op Render: zonder `TSDB_DISCOVERY_EXPANSION` flag → scan log identiek aan v15.0.13 + nieuwe `📡 OddsPapi bookies` regel.
- [ ] Met `TSDB_DISCOVERY_EXPANSION=1` → extra `🔭 Expansion-discovery` regel + `expansion=N/M leagues` in v15-sources regel.
- [ ] Cross-check OddsPapi-quote-count met `getUsage().remaining` voor en na scan: cap 5 mag niet > 250/maand quota-budget overschrijden.
- [ ] Beoordeel of bookies in `📡 OddsPapi bookies:` lijst onze preferred set dekken (Bet365, Unibet, Toto, BetCity). Zo nee → `unibet_nl` / `toto_nl` proberen of paid-tier discussie starten.

## Critical files in deze release

- `server.js:6450-6489` — Build A
- `server.js:6244-6253` — telemetry counters
- `server.js:7790-7860` — Build E v1 discovery block
- `server.js:8019-8027` — bookie-breakdown scan-log line
- `server.js:8015` — expansion counter in v15 sources line
- `lib/app-meta.js`, `package.json`, `package-lock.json`, `index.html`, `README.md`, `docs/PRIVATE_OPERATING_MODEL.md`, `test.js` — versie-bump v15.0.13 → v15.2.0
- `CHANGELOG.md` — volledige release-notes inclusief Build B/C/F/E-v2 deferral-rationale
