# EdgePickr v15.0.12 — TSDB Deep Usage Handoff

Started: 2026-04-29
Owner: Claude → review/extend by Codex
Base: v15.0.11 (`34bb411`)

## Goal

Operator vroeg een uitgebreide TSDB-audit met directe inbouw. Audit toonde dat we 0,03% van het TSDB Premium-budget gebruikten en dat 9 van de 16 geëxporteerde TSDB-functies dood-in-scan waren. v15.0.12 wired 5 endpoints in (allemaal achter env-flags) en levert deze handoff zodat Codex (a) mijn werk kan reviewen en (b) zelf kan beslissen of de resterende 4 endpoints waardevol genoeg zijn om in te bouwen.

## Wat ik heb gebouwd (v15.0.12)

| # | Endpoint / signaal | File(s) | Env-flag | Risk |
|---|---|---|---|---|
| 1 | `GET /api/admin/v2/tsdb-utilization` + `getUsage()` extended met `byEndpointPercent` + `dailyBudget` | `lib/integrations/sources/thesportsdb.js`, `lib/routes/admin-inspect.js` | n.v.t. | nul (read-only) |
| 2 | Venue-effect OU-nudge via `fetchVenue` | `lib/signals/venue-effect.js`, `server.js` rond regel 6543 | `TSDB_VENUE_EFFECT=1` | laag — additief, cap ±2pp |
| 3 | Lineup-strength ML-nudge via `fetchEventLineup` | `lib/signals/lineup-strength.js`, `server.js` rond regel 7000 | `TSDB_LINEUP_STRENGTH=1` | laag — alleen <90min vóór kickoff, cap ±1pp |
| 4 | Injury cross-check telemetrie via `fetchTeamRoster` | `lib/signals/injury-cross-check.js`, `server.js` rond regel 6770 | `TSDB_INJURY_VALIDATION=1` | nul — alleen telemetrie, geen pick-impact |
| 5 | Settlement event-stats enrichment worker via `fetchEventStats` | `lib/jobs/settlement-stats-enrichment.js`, `lib/runtime/maintenance-schedulers.js` | `TSDB_SETTLEMENT_ENRICHMENT=1` | nul tijdens scan — pure async post-settlement enrichment |

**Migratie:** `docs/migrations-archive/v15.0.12_bets_tsdb_event_stats.sql` voegt `bets.tsdb_event_stats` JSONB toe. Moet handmatig draaien:
```bash
node scripts/migrate.js docs/migrations-archive/v15.0.12_bets_tsdb_event_stats.sql
```

**Aggregator-uitbreidingen:** `getTeamRoster(sport, teamName)` toegevoegd in `lib/integrations/data-aggregator.js`. Hergebruikt TSDB findTeamId + fetchTeamRoster.

## Review-vragen voor Codex

1. **Venue-effect cap & schaal** (`lib/signals/venue-effect.js`):
   - `ALTITUDE_PER_KM_NUDGE = 0.008` (0,8pp per km boven 1500m). Is dat empirisch te onderbouwen? La Paz (3640m) → +1,7pp Over. Ik heb dit op gevoel ingesteld; vraag is of we tegen settled-bet data kunnen testen.
   - Capacity-factor `0.0006/1k`. Zwakker; misschien in v15.0.13 schrappen tot we capacity-correlatie kunnen meten. Klopt dat?
   - **TSDB venue-API levert geen altitude-veld.** Op dit moment is `venue.altitudeM` altijd undefined → alleen capacity-factor wint. Voor echte altitude-impact moeten we óf Open-Meteo elevation API toevoegen óf een hardcoded list voor bekende high-altitude stadions. Welke prefereer je?

2. **Lineup-strength signal-naam-conventie** (`lib/signals/lineup-strength.js`):
   - Signal-naam is `lineup_strength:+/-X.XX%`. `lib/picks.js` regel 169-174 filtert OU/BTTS markts op specifieke keywords; lineup-strength valt onder de "default true" branche en gaat dus mee in 1X2/ML-picks. Klopt dat de bedoeling, of moet het ook expliciet OU-relevant zijn?
   - Kickoff-window van 90min: misschien te eng voor early scans (07:30 NL). Vroege scan trekt fixtures van kickoffs > 90min later → lineup-fetch fired nooit. Wil je dat ik het verbreed naar 120min?

3. **Injury cross-check granulariteit** (`lib/signals/injury-cross-check.js`):
   - Mijn fuzzy-match gebruikt last-name token-match (≥1 token of substring). False-positive risk: gemeenschappelijke achternamen (Smith, García) → mismatch wanneer roster meerdere matches heeft maar inj-bron afwijkt. Heb je een betere normalisatie-strategie?
   - Per-team roster-fetch is +1 TSDB-call per team-met-blessures. Bij 22 fixtures × 80% met blessures × 2 teams = ~35 extra calls/scan. Acceptabel? Of moet caching agressiever?

4. **Settlement enrichment**: schedule-trigger (`scheduleSettlementEnrichment`):
   - Eerste run 5min na boot, daarna 24h-tick. Idle-CPU is verwaarloosbaar maar vraagt operator om bewust `TSDB_SETTLEMENT_ENRICHMENT=1` te zetten ná migratie. Zou je liever default-on willen na migration-detect (kolom-bestaan check) i.p.v. expliciete env-toggle?
   - Worker leest `bet.tsdb_event_id` als directe key, maar deze kolom bestaat nog niet. Op dit moment wordt elke bet als `eventId=null` geskipt. **Volgende slice nodig: bij bet-write OF tijdens enrichment-run de tsdb_event_id resolven via `fetchSchedulesByDate(bet.datum, sport)` + name-fuzzy match op `bet.wedstrijd`.** Kan jij dat bouwen?

5. **TSDB utilization endpoint**: dormant-list bevat alleen V1-endpoints; V2 endpoints (livescore, schedule) zijn niet expliciet als dormant gemarkeerd wanneer ze 0 calls hebben. Verbetering: voeg `livescore`, `schedule` toe aan de bekende-lijst. Triviaal, doe ik liever niet ad-hoc want de endpoint is read-only.

## Endpoints die NIET zijn ingebouwd (en waarom — beoordeel of jij het wel waardevol vindt)

### `fetchEventTimeline` (lookuptimeline.php)
**Wat:** minute-by-minute goal/card/sub events tijdens een wedstrijd.
**Use case:** Detect "team gives up after 60min" patroon → fatigue signal voor volgende fixture.
**Mijn redenering om te skippen:** value zit in *post-game* analyse die voedt naar volgende fixture, niet pre-match. Voor onze 3 scans/dag (07:30/14:00/21:00 Amsterdam) is dit signaal indirect. Bovendien vereist validatie een eigen calibratie-track (multi-week werk).
**Codex: oneens? Bouw het in als shadow-signal als je een concrete CLV-hypothese hebt.**

### `fetchEventTV` (lookuptv.php)
**Wat:** TV broadcasts per event.
**Use case:** Live-betting traffic-window, crowd-size proxy.
**Mijn redenering om te skippen:** wij doen pre-match betting, niet in-play. TV-broadcasts geven geen pre-match edge.
**Codex: agree?**

### `fetchLeagueNext` (eventsnextleague.php)
**Wat:** next 15 fixtures per league.
**Use case:** forward-looking league momentum (paired met `fetchLeaguePast` die we al gebruiken voor baseline).
**Mijn redenering om te skippen:** marginaal additief boven `fetchLeaguePast`. Beide tonen league-scoring patterns; "next" is meer voor scheduling-context, geen extra signaal.
**Codex: oneens? Test dan eens of next/past delta een meaningful momentum-signaal levert.**

### `fetchTeamFullSchedule` (V2 schedule/full/team/{id})
**Wat:** complete team schedule (vs V1 `eventslast` top-5).
**Use case:** rest-days / fixture-congestion modeling (bv. midweek UCL + weekend liga).
**Mijn redenering om te skippen:** existing api-sports `restDaysLookups` flow dekt fatigue al voor de meeste teams. Plus de V2 endpoint is premium-only met +1 call/team/dag → ~30 calls/scan extra voor marginal gain.
**Codex: zou je willen testen of V2 schedule rest-days nauwkeuriger zijn dan api-sports? Vooral relevant voor liga's waar api-sports thin is (Egyptian, Saudi).**

### `fetchScheduleByVenue` (V2 schedule/{next|previous}/venue/{id})
**Wat:** venue-centric scheduling.
**Use case:** twee high-profile matches op zelfde stadion zelfde week → pitch wear.
**Mijn redenering om te skippen:** niche, zeldzaam, +1 call/venue zonder duidelijke EV-case.
**Codex: agree.**

## Concrete vervolgstappen (prioriteit voor v15.0.13)

1. **`tsdb_event_id` resolution path** voor settled bets — zonder dit blijft Build 5 (settlement-enrichment) leeglopend.
2. **Open-Meteo elevation API** als tweede venue-bron, OF hardcoded altitude-list voor top-50 stadions met ≥1500m altitude.
3. **CLV-tracking per nieuwe signal**: na 7 dagen scans met `TSDB_VENUE_EFFECT=1` en `TSDB_LINEUP_STRENGTH=1`, run `signal-performance` admin-endpoint en kijk of `venue_over_under` en `lineup_strength` positive expected CLV laten zien. Zo nee → magnitude verlagen of disablen.
4. **Beslissen over `fetchEventTimeline` en `fetchTeamFullSchedule`** — als jij denkt dat een van die twee waarde levert, bouw als shadow-signal achter eigen env-flag.

## Verification (Claude post-deploy)

`npm test` na v15.0.12 implementatie:
- Verwacht: ~922 tests passing (bestaand 901 + 21 nieuwe).
- `node --check` schoon op alle aangeraakte bestanden.
- `npm run audit:high` 0 vulnerabilities.

Live verificatie na merge naar master + Render deploy:
1. `/api/admin/v2/tsdb-utilization` returnt `dailyBudget`, `byEndpoint`, `dormantEndpoints`.
2. Met `TSDB_VENUE_EFFECT=1`: scan-log toont `tsdb_venue=N/applied=M` regel.
3. Met `TSDB_LINEUP_STRENGTH=1`: na 06:00 scans zou `tsdb_lineup=N/applied=M` zichtbaar moeten zijn voor matches < 90min vóór kickoff (waarschijnlijk laat in de avond-scan).
4. Met `TSDB_INJURY_VALIDATION=1`: `tsdb_inj_checks=N/mismatch=M` zichtbaar.
5. Migratie `v15.0.12_bets_tsdb_event_stats.sql` apply'd; daarna `TSDB_SETTLEMENT_ENRICHMENT=1` aanzetten — eerste run 5min na boot logt `📊 settlement-enrichment: N bets enrichted`.

## Codex review-checklist

- [ ] Venue-effect altitude-bron toevoegen of het signaal afkappen tot capacity-only.
- [ ] Lineup-strength kickoff-window van 90 → 120min if early-scan dekking nodig is.
- [ ] Injury cross-check normalisatie-strategie verbeteren (huidige fuzzy is naïef).
- [ ] `tsdb_event_id` resolver bouwen voor settlement-enrichment (anders blijft worker leeglopend).
- [ ] CLV-impact van nieuwe signals na 7 dagen evalueren via `/api/admin/v2/signal-performance`.
- [ ] Beslissen over `fetchEventTimeline` en `fetchTeamFullSchedule` (zie sectie hierboven).
- [ ] Tests draaien: `npm test`, `npm run audit:high`, `node --check server.js lib/signals/venue-effect.js lib/signals/lineup-strength.js lib/signals/injury-cross-check.js lib/jobs/settlement-stats-enrichment.js lib/integrations/data-aggregator.js lib/integrations/sources/thesportsdb.js lib/routes/admin-inspect.js lib/runtime/maintenance-schedulers.js`.

## Vragen die ik open laat

- Of de v15.0.12 nudge-magnitudes (±2pp venue, ±1pp lineup) goed liggen of dat we die per signaal apart moeten kalibreren tegen settled-bet performance.
- Of de schedule-fetch eens per scan voldoende is voor venue-id mapping, of dat we per fixture een dedicated `lookupevent.php` call moeten doen voor exacte venue/lineup koppeling. Ik koos voor cheap (1 call) maar mogelijk loosely-matched.
- Of we tijdens deze v15.0.12 cyclus moeten valideren dat `oddspapi=on` consistent blijft (de v15.0.4 fix loste het op maar het is nog steeds een env-state). Niet kritisch nu — alleen als CLV-data laat zien dat sharp_anchor ontbreekt op meer fixtures dan verwacht.
