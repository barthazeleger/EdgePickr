'use strict';

// v10.9.0: Data aggregator — unified interface voor H2H, team-form en team-stats.
// Merged meerdere sources, dedupliceert op event-level, faalt gracefully.
//
// Design principes:
//   - Elke source-module implementeert subset van: fetchH2HEvents, fetchTeamFormEvents, fetchTeamSummary
//   - Aggregator roept alle ENABLED sources parallel aan per sport
//   - Events gededupliceerd op (date + sorted team-pair) → geen dubbel-tellen
//   - Bij fail van een source: skip, gebruik wat er wel is
//   - Master-kill-switch: OPERATOR.scraping_enabled respecteert aggregator niet direct;
//     caller in server.js moet deze check doen voor aggregator-calls
//
// Terugwaartse compatibiliteit: als geen enkele source enabled/werkt → aggregator
// returnt null / {events:[]} zodat caller kan falbacken op api-football.

const nbaStats = require('./sources/nba-stats');
const nhlApi = require('./sources/nhl-api');
const mlbExt = require('./sources/mlb-stats-ext');
// v12.5.12: TheSportsDB toegevoegd als alternatieve h2h-bron.
// v12.6.2: sofascore + fotmob volledig uitgefaseerd uit aggregator-registry.
// Beide waren vanaf Render's IP-segment al maandenlang dood (sofascore 403
// cloudflare-block, fotmob 404 endpoint-change), kwamen niet terug. Source-
// modules op disk gelaten voor git-historie + edge-case revival, maar geen
// runtime referenties meer. TSDB Premium + OddsAPI vullen het gat.
const thesportsdb = require('./sources/thesportsdb');
// v12.7.0-pre3 (v13.0 Phase 3): OddsPapi free-tier voor odds + events fallback.
// v13.0.2: hernoemd van oddsapi → oddspapi nadat scan toonde dat de service
// oddspapi.io is, niet the-odds-api.com.
const oddsapi = require('./sources/oddspapi');

const { normalizeTeamKey } = require('./scraper-base');

// Source-registry per sport. Elke sport-entry noemt welke sources beschikbaar zijn
// voor welk doel (h2h, form, summary). Sources worden sequentially geprobeerd,
// de aggregator verzamelt events van allemaal voor merge.
//
// v12.6.2: SPORT_SOURCES schoongemaakt — sofascore + fotmob uitgefaseerd.
// v12.7.0-pre3: per-sport registry uitgebreid met odds/lineups/livescore/
// schedule/venue/standings categorieën zodat aggregator nieuwe data-types
// uniform levert. Per-data-type prio-volgorde:
//   h2h         → TSDB primair (lookuph2h.php Patreon-only)
//   form        → TSDB v1 eventslast.php
//   odds        → OddsAPI primair (sharp Bet365/Pinnacle/Unibet)
//   lineups     → TSDB v1 lookuplineup.php
//   livescore   → TSDB v2 livescore (premium-only)
//   schedule    → TSDB v1 eventsday/eventsnextleague + OddsAPI events fallback
//   venue       → TSDB v1 lookupvenue
//   standings   → TSDB v1 lookuptable
//   summary     → sport-specifieke bron (nbaStats/nhlApi/mlbExt) blijft
//
// Drempelwaarde: bij sporten zonder TSDB-coverage of zonder OddsAPI sport-key
// returnt aggregator gewoon null/[] zodat caller op api-sports kan terugvallen.
const SPORT_SOURCES = {
  football: {
    h2h:       [thesportsdb],
    form:      [thesportsdb],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [],
  },
  basketball: {
    h2h:       [thesportsdb],
    form:      [],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [nbaStats],
  },
  hockey: {
    h2h:       [thesportsdb],
    form:      [],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [nhlApi],
  },
  baseball: {
    h2h:       [thesportsdb],
    form:      [],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [mlbExt],
  },
  handball: {
    h2h:       [thesportsdb],
    form:      [],
    odds:      [],            // OddsAPI heeft geen handball-keys
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [],
  },
  'american-football': {
    h2h:       [thesportsdb],
    form:      [],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [],
  },
  // v12.7.0-pre4: Phase 4 sport-uitbreiding. Tennis/rugby/cricket alleen
  // TSDB + OddsAPI (geen api-sports voor deze sporten). Lineups, venue,
  // standings hebben beperkt nut voor tennis/cricket maar registry blijft
  // uniform — adapter levert [] of null voor niet-toepasbare endpoints.
  tennis: {
    h2h:       [thesportsdb],
    form:      [thesportsdb],
    odds:      [oddsapi],
    lineups:   [],            // niet relevant in tennis
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [],            // tennis kent geen standings; rankings kunnen via player-data
    summary:   [],
  },
  rugby: {
    h2h:       [thesportsdb],
    form:      [thesportsdb],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [],
  },
  cricket: {
    h2h:       [thesportsdb],
    form:      [thesportsdb],
    odds:      [oddsapi],
    lineups:   [thesportsdb],
    livescore: [thesportsdb],
    schedule:  [thesportsdb, oddsapi],
    venue:     [thesportsdb],
    standings: [thesportsdb],
    summary:   [],
  },
};

// Deduplicate H2H events op (date, sorted team-pair normalized).
// Behoudt de eerste event bij duplicates.
function _dedupH2H(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const date = e.date || 'unknown';
    const a = normalizeTeamKey(e.homeTeam || '');
    const b = normalizeTeamKey(e.awayTeam || '');
    const pair = [a, b].sort().join('|');
    const key = `${date}::${pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// Compute aggregates vanuit dedup'ed H2H events.
function _summarizeH2H(events, team1Name, team2Name) {
  let n = 0, btts = 0, over25 = 0, totalGoals = 0;
  let team1Wins = 0, team2Wins = 0, draws = 0;
  const t1 = normalizeTeamKey(team1Name || '');
  const t2 = normalizeTeamKey(team2Name || '');
  const sources = new Set();
  for (const e of events) {
    const hs = e.homeScore, as = e.awayScore;
    if (typeof hs !== 'number' || typeof as !== 'number') continue;
    n++;
    totalGoals += hs + as;
    if (e.btts === true || (hs > 0 && as > 0)) btts++;
    if (hs + as > 2.5) over25++;
    const homeKey = normalizeTeamKey(e.homeTeam || '');
    const homeWon = hs > as, awayWon = as > hs;
    if (hs === as) draws++;
    else if (homeKey === t1 && homeWon) team1Wins++;
    else if (homeKey === t2 && homeWon) team2Wins++;
    else if (homeKey === t1 && awayWon) team2Wins++;
    else if (homeKey === t2 && awayWon) team1Wins++;
    if (e.source) sources.add(e.source);
  }
  return {
    n, btts, over25, draws, team1Wins, team2Wins,
    bttsRate: n > 0 ? +(btts / n).toFixed(3) : 0,
    over25Rate: n > 0 ? +(over25 / n).toFixed(3) : 0,
    avgGoals: n > 0 ? +(totalGoals / n).toFixed(2) : 0,
    sources: Array.from(sources),
  };
}

// Haal H2H data van alle enabled sources voor een sport. Merged + dedup.
// Fail-safe: elke source-fail wordt gelogd maar breekt niet de aggregator.
async function getMergedH2H(sport, team1Name, team2Name) {
  if (!team1Name || !team2Name) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.h2h) || !reg.h2h.length) return null;

  const results = await Promise.all(reg.h2h.map(async src => {
    try {
      if (typeof src.fetchH2HEvents !== 'function') return [];
      // v12.6.0: alle h2h-adapters accepteren sport als 3e arg. Adapters die
      // 't niet gebruiken (bijv. fotmob, football-only) negeren 'm gewoon —
      // JS positionele args zijn permissief. Voorheen branchde dit alleen op
      // sofascore; sinds TSDB ook sport-aware is werkt unified call beter.
      const events = await src.fetchH2HEvents(team1Name, team2Name, sport);
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }));

  const merged = _dedupH2H(results.flat());
  if (!merged.length) return null;

  const summary = _summarizeH2H(merged, team1Name, team2Name);
  return { events: merged, ...summary };
}

// Deduplicate form events per-team (by date). Behoud eerste.
function _dedupFormEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const date = e.date || `${e.myScore}-${e.oppScore}-${e.oppName || ''}`;
    const key = `${date}::${normalizeTeamKey(e.oppName || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function _summarizeForm(events) {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, cs = 0;
  let formStr = '';
  const sources = new Set();
  const sorted = [...events].sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta; // nieuwste eerst
  });
  for (const e of sorted) {
    const my = e.myScore, opp = e.oppScore;
    if (typeof my !== 'number' || typeof opp !== 'number') continue;
    gf += my; ga += opp;
    if (opp === 0) cs++;
    if (my > opp) { w++; formStr = 'W' + formStr; }
    else if (my < opp) { l++; formStr = 'L' + formStr; }
    else { d++; formStr = 'D' + formStr; }
    if (e.source) sources.add(e.source);
  }
  const n = w + d + l;
  if (n === 0) return null;
  return {
    n, w, d, l,
    gfPerGame: +(gf / n).toFixed(2),
    gaPerGame: +(ga / n).toFixed(2),
    cleanSheets: cs,
    cleanSheetPct: +(cs / n).toFixed(3),
    form: formStr.slice(0, 10),
    sources: Array.from(sources),
  };
}

async function getMergedForm(sport, teamName, limit = 10) {
  if (!teamName) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.form) || !reg.form.length) return null;

  // v12.6.2: alle resterende form-bronnen (post-sofascore) accepteren
  // (teamName, sport, limit) — uniform aanroepen.
  const results = await Promise.all(reg.form.map(async src => {
    try {
      if (typeof src.fetchTeamFormEvents !== 'function') return [];
      const events = await src.fetchTeamFormEvents(teamName, sport, limit);
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }));

  const merged = _dedupFormEvents(results.flat()).slice(0, limit);
  if (!merged.length) return null;

  const summary = _summarizeForm(merged);
  if (!summary) return null;
  return { events: merged, ...summary };
}

async function getTeamSummary(sport, teamName) {
  if (!teamName) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.summary) || !reg.summary.length) return null;

  for (const src of reg.summary) {
    try {
      if (typeof src.fetchTeamSummary !== 'function') continue;
      const s = await src.fetchTeamSummary(teamName);
      if (s) return s;
    } catch { /* try next */ }
  }
  return null;
}

// Aggregate health across all registered sources.
async function healthCheckAll() {
  // v12.7.0-pre3: oddsapi toegevoegd aan health-batch.
  const sources = [thesportsdb, oddsapi, nbaStats, nhlApi, mlbExt];
  const results = await Promise.all(sources.map(async src => {
    try { return await src.healthCheck(); }
    catch (e) { return { source: src.SOURCE_NAME, healthy: false, error: e.message }; }
  }));
  return results;
}

// ───────── v12.7.0-pre3 NIEUWE AGGREGATOR METHODS ────────────────────────────
//
// Design:
// - Elke method probeert de geregistreerde sources in volgorde uit SPORT_SOURCES
// - Eerste succesvolle source wint (pas anders bij odds: dan worden quotes
//   van alle sources gemerged voor cross-validation)
// - Fail-soft per source (try/catch), geen exceptions naar caller
// - Niet-ondersteunde sport → null/[]

// Dedup voor odds-quotes. Cross-source-aware: gebruikt (homeTeam, awayTeam,
// commenceTime, bookie, market, line, selection) als composite key — niet
// source-specific eventId — zodat OddsAPI eventId "3924959" en (toekomstig)
// TSDB eventId "12345678" voor dezelfde wedstrijd correct deduped worden.
// Bij prijs-disagreement >threshold tussen sources voor zelfde combo, returnt
// een single anomaly per combo (niet per iteration) zodat server.js één
// bookie_anomaly inbox-warning per echt-disagreement-event krijgt.
//
// v12.7.0-pre3 audit P1 fixes:
//   1. Number.isFinite(price) validatie → NaN-quotes worden geskipt vóór
//      anomaly-berekening (voorheen NaN deltapct → false comparison → silent slip)
//   2. Composite key incl. teams+commenceTime ipv enkel source-eventId
//   3. Anomaly-detection na complete dedup-loop, één keer per combo
function _dedupOdds(quotes, anomalyThresholdPct = 5) {
  const seen = new Map(); // key → {quote, sources: [{source, price}]}
  for (const q of quotes) {
    if (!q || !q.bookie || !q.market) continue;
    if (!Number.isFinite(q.price) || q.price <= 1.0) continue;  // P1#1 fix: NaN/invalid skip
    const line = q.line == null ? '' : String(q.line);
    // P1#2 fix: composite key op cross-source-stable identifiers (teams +
    // commenceTime) ipv source-specific eventId. Falls back to eventId als
    // teams missen (e.g. proprietary source-shape).
    // v12.7.0-pre4 audit P1-1 fix: teams gesorteerd zodat home/away swap
    // tussen sources (OddsAPI vs TSDB) niet alsnog dubbele entries oplevert.
    // Same as `_dedupH2H` pair-sort patroon.
    let matchKey;
    if (q.commenceTime && q.homeTeam && q.awayTeam) {
      const pair = [normalizeTeamKey(q.homeTeam), normalizeTeamKey(q.awayTeam)].sort().join('|');
      matchKey = `${q.commenceTime}::${pair}`;
    } else {
      matchKey = `evt::${q.eventId || ''}`;
    }
    const key = `${matchKey}::${q.bookie}::${q.market}::${line}::${q.selection || ''}`;
    if (!seen.has(key)) {
      seen.set(key, { quote: q, sources: [{ source: q.source, price: q.price }] });
      continue;
    }
    const entry = seen.get(key);
    entry.sources.push({ source: q.source, price: q.price });
  }
  // P1#3 fix: anomaly-detection na complete dedup-loop, één keer per combo
  // ipv binnen-loop herberekening. Voorkomt duplicate anomaly-rapportage bij
  // 3+ sources waar vroege iteraties al onder threshold zaten.
  const anomalies = [];
  for (const entry of seen.values()) {
    if (entry.sources.length < 2) continue;
    const prices = entry.sources.map(s => s.price).filter(p => Number.isFinite(p));
    if (prices.length < 2) continue;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    if (minPrice <= 1) continue;
    const deltaPct = (maxPrice - minPrice) / minPrice * 100;
    if (deltaPct > anomalyThresholdPct) {
      const q = entry.quote;
      anomalies.push({
        eventId: q.eventId, bookie: q.bookie, market: q.market, line: q.line,
        selection: q.selection, sources: entry.sources, deltaPct: +deltaPct.toFixed(2),
      });
    }
  }
  return {
    quotes: Array.from(seen.values()).map(e => e.quote),
    anomalies,
  };
}

// Merged odds. Default options: regions=eu,uk, markets=h2h,totals,spreads,
// bookmakers=Bet365/Pinnacle/Unibet/WilliamHill (canonical execution-set).
//
// Returns: `{quotes: [...], anomalies: [...], sources: [...]}` of null als
// niet ondersteund / geen data. Anomalies bevatten cross-source price-
// disagreements (caller kan via server.js bookie_anomaly inbox-warning sturen).
async function getMergedOdds(sport, options = {}) {
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.odds) || !reg.odds.length) return null;

  const { league = null, ...passthrough } = options;
  const allQuotes = [];
  const sourcesUsed = new Set();

  for (const src of reg.odds) {
    try {
      // OddsAPI heeft eigen sport-key (soccer_epl, basketball_nba, etc.)
      // resolve via adapter's eigen mapping. Caller kan league overrulen.
      let sportKey = null;
      if (src === oddsapi && typeof src.resolveOddsApiKey === 'function') {
        sportKey = src.resolveOddsApiKey(sport, league);
      }
      if (!sportKey) continue;
      const quotes = await src.fetchOdds(sportKey, { sport, ...passthrough });
      if (Array.isArray(quotes) && quotes.length) {
        allQuotes.push(...quotes);
        sourcesUsed.add(src.SOURCE_NAME);
      }
    } catch { /* fail-soft */ }
  }

  if (!allQuotes.length) return null;
  const { quotes, anomalies } = _dedupOdds(allQuotes);
  return {
    quotes,
    anomalies,
    sources: Array.from(sourcesUsed),
  };
}

// Livescore per sport. TSDB v2 primair (premium-only), terugval [] op free-key
// of als geen sources geconfigureerd. Voor sporten waar TSDB thin is kan caller
// alsnog ESPN Scoreboard direct in server.js consulteren.
async function getLivescore(sport) {
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.livescore) || !reg.livescore.length) return [];

  for (const src of reg.livescore) {
    try {
      if (typeof src.fetchLivescore !== 'function') continue;
      const events = await src.fetchLivescore(sport);
      if (Array.isArray(events) && events.length) return events;
    } catch { /* try next */ }
  }
  return [];
}

// Lineups per event. Eerste succesvolle source wint (geen merge — lineups zijn
// canoniek per source en mengen levert geen extra waarde).
async function getLineups(sport, eventId) {
  if (!eventId) return [];
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.lineups) || !reg.lineups.length) return [];

  for (const src of reg.lineups) {
    try {
      if (typeof src.fetchEventLineup !== 'function') continue;
      const lineup = await src.fetchEventLineup(eventId);
      if (Array.isArray(lineup) && lineup.length) return lineup;
    } catch { /* try next */ }
  }
  return [];
}

// Schedule per dag. TSDB primair (sport-aware date-filter), OddsAPI events als
// fallback (geen quota-cost). Returnt eerste niet-lege resultaat.
async function getEventSchedule(sport, date, options = {}) {
  if (!date) return [];
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.schedule) || !reg.schedule.length) return [];

  for (const src of reg.schedule) {
    try {
      // TSDB heeft fetchSchedulesByDate(date, sport)
      if (typeof src.fetchSchedulesByDate === 'function') {
        const fixtures = await src.fetchSchedulesByDate(date, sport);
        if (Array.isArray(fixtures) && fixtures.length) return fixtures;
      }
      // OddsAPI fallback via events endpoint (geen quota-cost). Mapt sport+league
      // → OddsAPI sport-key.
      if (src === oddsapi && typeof src.resolveOddsApiKey === 'function') {
        const sportKey = src.resolveOddsApiKey(sport, options.league || null);
        if (sportKey && typeof src.fetchEvents === 'function') {
          const events = await src.fetchEvents(sportKey);
          if (Array.isArray(events) && events.length) {
            // P1#3 fix: timezone-aware date-filter. OddsAPI commenceTime is UTC
            // ISO ("2026-05-15T23:30:00Z"); caller-date is meestal lokale (NL)
            // kalenderdag. UTC 23:30 → 01:30 NL volgende dag, mismatch op slice.
            // Default timezone Europe/Amsterdam (operator-locale uit CLAUDE.md);
            // overrideable via options.timezone voor edge-cases.
            const tz = options.timezone || 'Europe/Amsterdam';
            const filtered = events.filter(ev => {
              if (!ev.commenceTime) return false;
              try {
                const localDate = new Date(ev.commenceTime).toLocaleDateString('sv-SE', { timeZone: tz });
                return localDate === date;
              } catch { return false; }
            });
            if (filtered.length) return filtered;
          }
        }
      }
    } catch { /* try next */ }
  }
  return [];
}

// Venue details. Eerste hit wint.
async function getVenueDetails(sport, venueId) {
  if (!venueId) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.venue) || !reg.venue.length) return null;

  for (const src of reg.venue) {
    try {
      if (typeof src.fetchVenue !== 'function') continue;
      const v = await src.fetchVenue(venueId);
      if (v) return v;
    } catch { /* try next */ }
  }
  return null;
}

// Standings per league. Eerste hit wint.
async function getStandings(sport, leagueId, season) {
  if (!leagueId) return [];
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.standings) || !reg.standings.length) return [];

  for (const src of reg.standings) {
    try {
      if (typeof src.fetchStandings !== 'function') continue;
      const rows = await src.fetchStandings(leagueId, season);
      if (Array.isArray(rows) && rows.length) return rows;
    } catch { /* try next */ }
  }
  return [];
}

module.exports = {
  SPORT_SOURCES,
  getMergedH2H,
  getMergedForm,
  getTeamSummary,
  healthCheckAll,
  // v12.7.0-pre3 nieuwe aggregator-methods
  getMergedOdds,
  getLivescore,
  getLineups,
  getEventSchedule,
  getVenueDetails,
  getStandings,
  // Exported voor tests:
  _dedupH2H,
  _summarizeH2H,
  _dedupFormEvents,
  _summarizeForm,
  _dedupOdds,
};
