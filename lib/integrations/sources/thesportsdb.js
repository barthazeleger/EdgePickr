'use strict';

// v12.5.12: TheSportsDB adapter — H2H events voor football. Free test-key
// werkt zonder account voor diagnose; premium-key (TSDB_API_KEY env var)
// vereist voor productie-throughput.
//
// v12.6.0: multi-sport + premium-aware. Adapter ondersteunt nu basketball,
// hockey, baseball, american-football, handball naast football. Premium-key
// (Patreon $9/mnd of site-direct) detectie via key !== '3' geeft hogere
// rate-limit (100/min) en V2 API access (header-auth, livescore-endpoints).
//
// v12.7.0-pre1: brede endpoint-uitbreiding voor v13.0 multi-source pivot.
// 13 nieuwe methods (80% v1, 20% v2) volgens endpoint-keuze-doctrine in
// /Users/maxperian/.claude/plans/composed-meandering-thacker.md. Per-TTL
// cache-buckets ipv één 24h-cache zodat livescore (30s) en venue (7d) niet
// op dezelfde TTL zitten.
//
// Endpoints V1 (URL-key auth, free + premium):
//   searchteams.php / lookuph2h.php / lookuptable.php / lookuplineup.php /
//   lookupeventstats.php / lookuptimeline.php / lookuptv.php / lookupvenue.php /
//   eventslast.php / eventsday.php / eventsnextleague.php / eventspastleague.php /
//   lookup_all_players.php
// Endpoints V2 (header-auth X-API-KEY, premium-only):
//   livescore/{sport} / schedule/full/team/{id} / schedule/{next|previous}/venue/{id}
//
// TheSportsDB strSport-mapping (V1 search): Soccer / Basketball / Ice Hockey
// / Baseball / American Football / Handball.

const {
  RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled, normalizeTeamKey, safeFetch,
} = require('../scraper-base');

const SOURCE_NAME = 'thesportsdb';
const HOST = 'www.thesportsdb.com';
const ALLOWED = [HOST];
// API-key uit env, fallback op gratis test-key '3'. Test-key heeft beperkte
// throughput maar genoeg voor diagnose + thin-h2h fallback.
const API_KEY = process.env.TSDB_API_KEY || '3';
const IS_PREMIUM = API_KEY !== '3';
const BASE_V1 = `https://${HOST}/api/v1/json/${API_KEY}`;
// V2 base: key gaat in header (X-API-KEY), niet in URL.
const BASE_V2 = `https://${HOST}/api/v2/json`;

// Premium = 100 req/min ≈ 600ms interval, free '3'-key = strikter ~1500ms.
const RATE_LIMIT_MS = IS_PREMIUM ? 600 : 1500;

// v12.7.0-pre1: per-TTL cache-buckets. Eerder één globale 24h-cache; nu
// gescheiden zodat livescore (30s) en venue (7d) elk hun eigen TTL hebben.
// Bucket-keys verwijzen naar typische staleness van het type data:
//   livescore — fixture in-progress, refresh elke scan-tick
//   short     — match details die tijdens live wedstrijd nog veranderen
//   hour      — schedules-by-date/league/venue
//   medium    — standings/form/full-team-schedule/roster
//   day       — H2H events / team-id (changes rarely)
//   week      — venue / final timeline (immutable)
const _caches = {
  livescore: new TTLCache(30 * 1000,                500),
  short:     new TTLCache(30 * 60 * 1000,          1000),
  hour:      new TTLCache(60 * 60 * 1000,           500),
  medium:    new TTLCache(6 * 60 * 60 * 1000,       500),
  day:       new TTLCache(24 * 60 * 60 * 1000,     2000),
  week:      new TTLCache(7 * 24 * 60 * 60 * 1000,  500),
};
// Backwards-compat alias voor bestaande code-paden (findTeamId / fetchH2HEvents
// gebruiken bare `cache`-references van vóór v12.7.0-pre1 multi-bucket split).
// Day-bucket TTL (24h) is intentioneel voor team-id en h2h — beide veranderen
// zelden. Toekomstige contributors: zie `_caches`-comment hierboven voor de
// rest van de bucket-architectuur.
const cache = _caches.day;

const rl = new RateLimiter(RATE_LIMIT_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 5,
  minCooldownMs: 5 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
}));

// v12.6.3: per-day call-counter voor /api/status zichtbaarheid. Resets om
// middernacht Amsterdam (consistent met api-sports counters in server.js).
// Geen maandlimiet bij TSDB Premium (100 req/min rate-limit, geen quota),
// dus pure observability — niet voor throttling.
let _callsToday = 0;
let _callsTodayDate = null;
function _amsterdamDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
}
function _bumpUsageCounter() {
  const d = _amsterdamDate();
  if (_callsTodayDate !== d) { _callsTodayDate = d; _callsToday = 0; }
  _callsToday++;
}

// TheSportsDB wil simpele Accept-header, geen browser-spoofing. V2 vereist
// daarnaast X-API-KEY header voor authenticatie.
const HEADERS_V1 = { 'Accept': 'application/json' };
const HEADERS_V2 = { 'Accept': 'application/json', 'X-API-KEY': API_KEY };

// EdgePickr-sport → TheSportsDB strSport-string. Wordt gebruikt om search-
// resultaten te filteren zodat we niet per ongeluk een team uit een andere
// sport pakken (bijv. "Lakers" bestaat in basketball én anderen).
const SPORT_MAP = Object.freeze({
  football:           'Soccer',
  basketball:         'Basketball',
  hockey:             'Ice Hockey',
  baseball:           'Baseball',
  'american-football': 'American Football',
  handball:           'Handball',
  // v12.7.0-pre4: Phase 4 sport-uitbreiding. TSDB strSport-strings exact zoals
  // ze in de database staan (case-sensitive in V1 search filtering).
  tennis:             'Tennis',
  rugby:              'Rugby',
  cricket:            'Cricket',
});

function _strSportFor(sport) { return SPORT_MAP[sport] || 'Soccer'; }

// v12.7.0-pre1 audit P2: input-validatie helper. ID-args (eventId, teamId,
// venueId, leagueId) komen van caller-input → defensive normaliseren naar
// non-empty string. Voorkomt dat `fetchEventLineup('')` of `fetchVenue(0)` per
// ongeluk een cache-write triggert met malformed key.
//
// TSDB IDs zijn altijd positieve integers (4-7 digits typisch); 0 of negatief
// is nooit een geldig ID. Numeric inputs worden naar string genormaliseerd
// voor cache-key consistency.
function _validId(x) {
  if (x === null || x === undefined || x === false) return null;
  if (typeof x === 'number' && (!Number.isFinite(x) || x <= 0)) return null;
  const s = String(x).trim();
  if (!s || s === '0' || !/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  return s;
}

// v12.6.1: Returnt {data, called} ipv kale data zodat callers kunnen
// onderscheiden tussen "API daadwerkelijk aangeroepen, geen match" (cache-baar
// als negatief resultaat) en "skip/transient fail" (NIET cachen — anders
// blijft 24u stale state hangen als source later weer enabled wordt).
async function _get(url, useV2 = false) {
  if (!isSourceEnabled(SOURCE_NAME)) return { data: null, called: false };
  if (!breaker.allow()) return { data: null, called: false };
  // V2 zonder premium-key faalt met 401 — niet pingen.
  if (useV2 && !IS_PREMIUM) return { data: null, called: false };
  await rl.acquire();
  const headers = useV2 ? HEADERS_V2 : HEADERS_V1;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: headers, returnDetails: true,
  });
  if (!details || !details.ok || !details.data) {
    breaker.onFailure(details?.error || 'unknown');
    // Network/HTTP fail = transient, niet cachen.
    return { data: null, called: false };
  }
  breaker.onSuccess();
  _bumpUsageCounter();
  return { data: details.data, called: true };
}

// v12.6.3: status-page voert dit elke status-refresh uit zodat operator de
// daily call-volume kan zien naast de api-sports counters.
function getUsage() {
  return {
    source: SOURCE_NAME,
    callsToday: _callsToday,
    date: _callsTodayDate,
    rateLimitMs: RATE_LIMIT_MS,
    premium: IS_PREMIUM,
  };
}

async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  // Pingt searchteams met bekende naam — V1-endpoint werkt voor alle keys.
  const url = `${BASE_V1}/searchteams.php?t=${encodeURIComponent('Arsenal')}`;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: HEADERS_V1, returnDetails: true,
  });
  const latency = Date.now() - t0;
  // TheSportsDB returnt {teams: [...]} of {teams: null} bij geen match.
  // Voor health: 200 + parseable JSON = healthy. Lege teams-array is OK
  // (key werkt, gewoon geen match — onwaarschijnlijk voor "Arsenal").
  const healthy = details && details.ok && details.data
    && (Array.isArray(details.data.teams) || details.data.teams === null);
  if (!healthy) breaker.onFailure(details?.error || 'unknown');
  else breaker.onSuccess();
  return {
    source: SOURCE_NAME,
    healthy: !!healthy,
    latencyMs: latency,
    httpStatus: details?.status ?? 0,
    error: healthy ? null : (details?.error || 'unknown'),
    breaker: breaker.status(),
    premium: IS_PREMIUM,
  };
}

// Find team ID by name. Sport-aware filtering: alleen kandidaten waar
// strSport matcht met de gevraagde EdgePickr-sport komen in aanmerking.
// Voorkomt cross-sport-matches (bijv. basketball-team gevonden bij
// football-zoekopdracht).
async function findTeamId(teamName, sport = 'football') {
  if (!teamName || typeof teamName !== 'string') return null;
  const cacheKey = `tsdb:team:${sport}:${normalizeTeamKey(teamName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const query = teamName.slice(0, 120);
  const url = `${BASE_V1}/searchteams.php?t=${encodeURIComponent(query)}`;
  const { data, called } = await _get(url);
  // Skip/transient fail → niet cachen, volgende call mag retryen.
  if (!called) return null;
  if (!data || !Array.isArray(data.teams)) {
    // API antwoordde maar zonder teams-array — legit "geen match", cache 24h.
    cache.set(cacheKey, null);
    return null;
  }

  const expectedSport = _strSportFor(sport);
  const normTarget = normalizeTeamKey(teamName);
  const candidates = data.teams.filter(t => {
    if (!t || !t.idTeam || !t.strTeam) return false;
    if (t.strSport && t.strSport !== expectedSport) return false;
    return true;
  });

  if (!candidates.length) {
    cache.set(cacheKey, null);
    return null;
  }

  // Voorkeur: exacte normalized name, anders eerste hit.
  let chosen = null;
  for (const t of candidates) {
    if (normalizeTeamKey(t.strTeam) === normTarget) { chosen = t; break; }
    // Soms staat de bekende naam in alternateName:
    if (t.strAlternate) {
      const alts = t.strAlternate.split(',').map(s => normalizeTeamKey(s.trim()));
      if (alts.includes(normTarget)) { chosen = t; break; }
    }
  }
  if (!chosen) chosen = candidates[0];
  const result = { id: String(chosen.idTeam), name: chosen.strTeam };
  cache.set(cacheKey, result);
  return result;
}

// H2H events tussen twee teams. lookuph2h endpoint returnt laatste matches.
// Premium-key vereist voor consistente response; free-key '3' krijgt vaak
// `null` voor lookuph2h (Patreon-only feature volgens docs).
async function fetchH2HEvents(teamAName, teamBName, sport = 'football') {
  if (!teamAName || !teamBName) return [];
  const cacheKey = `tsdb:h2h:${sport}:${normalizeTeamKey(teamAName)}|${normalizeTeamKey(teamBName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const tA = await findTeamId(teamAName, sport);
  if (!tA) { cache.set(cacheKey, []); return []; }
  const tB = await findTeamId(teamBName, sport);
  if (!tB) { cache.set(cacheKey, []); return []; }

  const url = `${BASE_V1}/lookuph2h.php?id=${encodeURIComponent(tA.id)}&id2=${encodeURIComponent(tB.id)}`;
  const { data, called } = await _get(url);
  // Skip/transient fail → niet cachen.
  if (!called) return [];
  // TheSportsDB v1: response is {event: [...]} bij premium-key, vaak null
  // bij free-key (lookuph2h is patreon-only). Defensieve parsing.
  const raw = data?.event || data?.events || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    cache.set(cacheKey, []);
    return [];
  }

  const events = [];
  for (const ev of raw) {
    if (!ev) continue;
    const home = ev.strHomeTeam;
    const away = ev.strAwayTeam;
    const hs = parseInt(ev.intHomeScore, 10);
    const as = parseInt(ev.intAwayScore, 10);
    if (!home || !away) continue;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    if (hs < 0 || as < 0 || hs > 200 || as > 200) continue;
    const date = ev.dateEvent || ev.strTimestamp?.slice(0, 10) || null;
    events.push({
      source: 'thesportsdb',
      sport,
      date,
      homeTeam: String(home).slice(0, 200),
      awayTeam: String(away).slice(0, 200),
      homeScore: hs,
      awayScore: as,
      totalGoals: hs + as,
      btts: hs > 0 && as > 0,
    });
  }
  cache.set(cacheKey, events);
  return events;
}

// v12.7.0-pre1: real impl. eventslast.php returnt 5 recent finished events per
// team-ID. Sport-aware (kan filtere op date desc). Output-shape compatible met
// data-aggregator's `_dedupFormEvents` / `_summarizeForm` (verwacht
// {date, myScore, oppScore, oppName, source}).
async function fetchTeamFormEvents(teamName, sport = 'football', limit = 10) {
  if (!teamName || typeof teamName !== 'string') return [];
  // v12.7.0-pre1 audit P2: bound limit zodat caller geen unieke cache-keys kan
  // genereren door extreem-grote limits door te geven (cache-bloat-vector).
  // 100 is ruim boven realistische form-window (10-20 events).
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 100) limit = 100;
  const cacheKey = `tsdb:form:${sport}:${normalizeTeamKey(teamName)}:${limit}`;
  const cached = _caches.medium.get(cacheKey);
  if (cached !== undefined) return cached;

  const team = await findTeamId(teamName, sport);
  if (!team) { _caches.medium.set(cacheKey, []); return []; }

  const url = `${BASE_V1}/eventslast.php?id=${encodeURIComponent(team.id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.results || data?.events || data?.event || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    _caches.medium.set(cacheKey, []);
    return [];
  }

  const myKey = normalizeTeamKey(teamName);
  const out = [];
  for (const ev of raw) {
    if (!ev) continue;
    const home = ev.strHomeTeam, away = ev.strAwayTeam;
    const hs = parseInt(ev.intHomeScore, 10);
    const as = parseInt(ev.intAwayScore, 10);
    if (!home || !away) continue;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    if (hs < 0 || as < 0 || hs > 200 || as > 200) continue;
    const homeIsMine = normalizeTeamKey(home) === myKey;
    const myScore  = homeIsMine ? hs : as;
    const oppScore = homeIsMine ? as : hs;
    const oppName  = homeIsMine ? String(away).slice(0, 200) : String(home).slice(0, 200);
    out.push({
      source: 'thesportsdb',
      sport,
      date: ev.dateEvent || ev.strTimestamp?.slice(0, 10) || null,
      myScore, oppScore, oppName,
    });
    if (out.length >= limit) break;
  }
  _caches.medium.set(cacheKey, out);
  return out;
}

// ───────── v12.7.0-pre1 NIEUWE ENDPOINTS ─────────────────────────────────────

// Standings per league per season. v1 lookuptable.php returnt {table:[...]}
// met intRank/intPlayed/intWin/intDraw/intLoss/intGoalsFor/intGoalsAgainst etc.
async function fetchStandings(leagueId, season) {
  const id = _validId(leagueId);
  if (!id) return [];
  const seasonStr = season ? String(season).trim().slice(0, 30) : '';
  const cacheKey = `tsdb:standings:${id}:${seasonStr}`;
  const cached = _caches.medium.get(cacheKey);
  if (cached !== undefined) return cached;

  const qs = seasonStr ? `?l=${encodeURIComponent(id)}&s=${encodeURIComponent(seasonStr)}`
                       : `?l=${encodeURIComponent(id)}`;
  const url = `${BASE_V1}/lookuptable.php${qs}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.table || [];
  if (!Array.isArray(raw)) { _caches.medium.set(cacheKey, []); return []; }

  const rows = raw.map(r => ({
    source: 'thesportsdb',
    rank:        parseInt(r.intRank, 10) || null,
    teamId:      r.idTeam ? String(r.idTeam) : null,
    teamName:    String(r.strTeam || '').slice(0, 200),
    played:      parseInt(r.intPlayed, 10) || 0,
    wins:        parseInt(r.intWin, 10) || 0,
    draws:       parseInt(r.intDraw, 10) || 0,
    losses:      parseInt(r.intLoss, 10) || 0,
    goalsFor:    parseInt(r.intGoalsFor, 10) || 0,
    goalsAgainst:parseInt(r.intGoalsAgainst, 10) || 0,
    goalDiff:    parseInt(r.intGoalDifference, 10) || 0,
    points:      parseInt(r.intPoints, 10) || 0,
    form:        typeof r.strForm === 'string' ? r.strForm.slice(0, 10) : '',
  })).filter(r => r.teamId);
  _caches.medium.set(cacheKey, rows);
  return rows;
}

// Event lineup per event-ID. v1 lookuplineup.php returnt {lineup:[...]} met
// per-player shape {idPlayer, strPlayer, strPosition, strFormation, strSubstitute}.
// Cache 30min — lineups kunnen tot kickoff veranderen.
async function fetchEventLineup(eventId) {
  const id = _validId(eventId);
  if (!id) return [];
  const cacheKey = `tsdb:lineup:${id}`;
  const cached = _caches.short.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookuplineup.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.lineup || [];
  if (!Array.isArray(raw)) { _caches.short.set(cacheKey, []); return []; }

  const players = raw.map(p => ({
    source: 'thesportsdb',
    playerId: p.idPlayer ? String(p.idPlayer) : null,
    name: String(p.strPlayer || '').slice(0, 120),
    position: String(p.strPosition || '').slice(0, 40),
    teamId: p.idTeam ? String(p.idTeam) : null,
    isSubstitute: p.strSubstitute === 'Yes' || p.intSubstitute === '1',
    formation: String(p.strFormation || '').slice(0, 20),
  })).filter(p => p.playerId && p.name);
  _caches.short.set(cacheKey, players);
  return players;
}

// Event match-stats per event-ID. v1 lookupeventstats.php returnt {eventstats}
// met o.a. shots/possession/corners/fouls. Sport-afhankelijk welke stat-types.
async function fetchEventStats(eventId) {
  const id = _validId(eventId);
  if (!id) return [];
  const cacheKey = `tsdb:eventstats:${id}`;
  const cached = _caches.short.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookupeventstats.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.eventstats || [];
  if (!Array.isArray(raw)) { _caches.short.set(cacheKey, []); return []; }

  const stats = raw.map(s => ({
    source: 'thesportsdb',
    statType: String(s.strStat || '').slice(0, 60),
    home: s.intHome != null ? String(s.intHome).slice(0, 20) : null,
    away: s.intAway != null ? String(s.intAway).slice(0, 20) : null,
  })).filter(s => s.statType);
  _caches.short.set(cacheKey, stats);
  return stats;
}

// Event timeline per event-ID. v1 lookuptimeline.php returnt {timeline:[...]}
// met per-event-line shape {strTimeline, intTime, strHomeGoalDetails}.
// TTL: 30min als event nog live, 7d als final. Caller signal via isFinal=true.
async function fetchEventTimeline(eventId, isFinal = false) {
  const id = _validId(eventId);
  if (!id) return [];
  const cacheKey = `tsdb:timeline:${id}:${isFinal ? 'final' : 'live'}`;
  const c = isFinal ? _caches.week : _caches.short;
  const cached = c.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookuptimeline.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.timeline || [];
  if (!Array.isArray(raw)) { c.set(cacheKey, []); return []; }

  const events = raw.map(t => ({
    source: 'thesportsdb',
    minute: parseInt(t.intTime, 10) || 0,
    type: String(t.strTimeline || '').slice(0, 40),
    team: String(t.strTeam || '').slice(0, 40),
    detail: String(t.strHomeGoalDetails || t.strAwayGoalDetails || '').slice(0, 200),
  })).filter(e => e.type);
  c.set(cacheKey, events);
  return events;
}

// Event TV broadcasts per event-ID. v1 lookuptv.php returnt {tvevents:[...]}.
// Waardevol voor live-betting timing (welke matches op TV → traffic-spike-window).
async function fetchEventTV(eventId) {
  const id = _validId(eventId);
  if (!id) return [];
  const cacheKey = `tsdb:tv:${id}`;
  const cached = _caches.day.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookuptv.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.tvevents || [];
  if (!Array.isArray(raw)) { _caches.day.set(cacheKey, []); return []; }

  const broadcasts = raw.map(b => ({
    source: 'thesportsdb',
    channel: String(b.strChannel || '').slice(0, 80),
    country: String(b.strCountry || '').slice(0, 60),
    logo: typeof b.strLogo === 'string' ? b.strLogo.slice(0, 200) : null,
  })).filter(b => b.channel);
  _caches.day.set(cacheKey, broadcasts);
  return broadcasts;
}

// Schedules-by-date filtered op sport. v1 eventsday.php?d={YYYY-MM-DD}&s={SPORT}.
// Sport gebruikt strSport-vorm (Soccer / Ice Hockey / etc), MAP via SPORT_MAP.
async function fetchSchedulesByDate(date, sport = 'football') {
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const strSport = _strSportFor(sport);
  const cacheKey = `tsdb:schedule-day:${date}:${sport}`;
  const cached = _caches.hour.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/eventsday.php?d=${encodeURIComponent(date)}&s=${encodeURIComponent(strSport)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.events || [];
  if (!Array.isArray(raw)) { _caches.hour.set(cacheKey, []); return []; }

  const fixtures = raw.map(ev => ({
    source: 'thesportsdb',
    sport,
    eventId: ev.idEvent ? String(ev.idEvent) : null,
    leagueId: ev.idLeague ? String(ev.idLeague) : null,
    leagueName: String(ev.strLeague || '').slice(0, 120),
    homeTeam: String(ev.strHomeTeam || '').slice(0, 200),
    awayTeam: String(ev.strAwayTeam || '').slice(0, 200),
    date: ev.dateEvent || null,
    time: ev.strTime || null,
    timestamp: ev.strTimestamp || null,
    venueId: ev.idVenue ? String(ev.idVenue) : null,
    venueName: String(ev.strVenue || '').slice(0, 200),
    status: String(ev.strStatus || '').slice(0, 40),
  })).filter(f => f.eventId);
  _caches.hour.set(cacheKey, fixtures);
  return fixtures;
}

// League next/past events. v1 eventsnextleague.php / eventspastleague.php.
// Returnt 15 fixtures (past) of upcoming events per league-ID.
async function _fetchLeagueEvents(leagueId, direction) {
  const id = _validId(leagueId);
  if (!id) return [];
  if (direction !== 'next' && direction !== 'past') return [];
  const cacheKey = `tsdb:league-${direction}:${id}`;
  const cached = _caches.hour.get(cacheKey);
  if (cached !== undefined) return cached;

  const file = direction === 'next' ? 'eventsnextleague.php' : 'eventspastleague.php';
  const url = `${BASE_V1}/${file}?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.events || [];
  if (!Array.isArray(raw)) { _caches.hour.set(cacheKey, []); return []; }

  const fixtures = raw.map(ev => ({
    source: 'thesportsdb',
    eventId: ev.idEvent ? String(ev.idEvent) : null,
    leagueId: ev.idLeague ? String(ev.idLeague) : String(leagueId),
    homeTeam: String(ev.strHomeTeam || '').slice(0, 200),
    awayTeam: String(ev.strAwayTeam || '').slice(0, 200),
    date: ev.dateEvent || null,
    time: ev.strTime || null,
    timestamp: ev.strTimestamp || null,
    venueId: ev.idVenue ? String(ev.idVenue) : null,
    homeScore: parseInt(ev.intHomeScore, 10),
    awayScore: parseInt(ev.intAwayScore, 10),
    status: String(ev.strStatus || '').slice(0, 40),
  })).filter(f => f.eventId);
  _caches.hour.set(cacheKey, fixtures);
  return fixtures;
}
function fetchLeagueNext(leagueId) { return _fetchLeagueEvents(leagueId, 'next'); }
function fetchLeaguePast(leagueId) { return _fetchLeagueEvents(leagueId, 'past'); }

// Venue details per venue-ID. v1 lookupvenue.php.
async function fetchVenue(venueId) {
  const id = _validId(venueId);
  if (!id) return null;
  const cacheKey = `tsdb:venue:${id}`;
  const cached = _caches.week.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookupvenue.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return null;
  const raw = (data?.venues || data?.venue || [])[0];
  if (!raw) { _caches.week.set(cacheKey, null); return null; }

  const venue = {
    source: 'thesportsdb',
    venueId: raw.idVenue ? String(raw.idVenue) : id,
    name: String(raw.strVenue || '').slice(0, 200),
    capacity: parseInt(raw.intCapacity, 10) || null,
    city: String(raw.strCity || '').slice(0, 80),
    country: String(raw.strCountry || '').slice(0, 80),
    sport: String(raw.strSport || '').slice(0, 60),
  };
  _caches.week.set(cacheKey, venue);
  return venue;
}

// Squad-roster per team-ID. v1 lookup_all_players.php returnt {player:[...]}.
// Voor injury cross-check: mag schaal-detecteren of een specifieke player in
// roster zit voordat blessure-data wordt gegenereerd.
async function fetchTeamRoster(teamId) {
  const id = _validId(teamId);
  if (!id) return [];
  const cacheKey = `tsdb:roster:${id}`;
  const cached = _caches.medium.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V1}/lookup_all_players.php?id=${encodeURIComponent(id)}`;
  const { data, called } = await _get(url);
  if (!called) return [];
  const raw = data?.player || [];
  if (!Array.isArray(raw)) { _caches.medium.set(cacheKey, []); return []; }

  const players = raw.map(p => ({
    source: 'thesportsdb',
    playerId: p.idPlayer ? String(p.idPlayer) : null,
    name: String(p.strPlayer || '').slice(0, 120),
    position: String(p.strPosition || '').slice(0, 40),
    nationality: String(p.strNationality || '').slice(0, 60),
    dob: p.dateBorn || null,
  })).filter(p => p.playerId && p.name);
  _caches.medium.set(cacheKey, players);
  return players;
}

// V2: Livescore per sport. Premium-only (header-auth). Returnt actieve events
// met live scores. Op v1 niet beschikbaar — daarom v2-only.
async function fetchLivescore(sport = 'football') {
  const strSport = _strSportFor(sport);
  const cacheKey = `tsdb:livescore:${strSport}`;
  const cached = _caches.livescore.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V2}/livescore/${encodeURIComponent(strSport)}`;
  const { data, called } = await _get(url, /*useV2=*/ true);
  if (!called) return [];
  const raw = data?.livescore || data?.events || [];
  if (!Array.isArray(raw)) { _caches.livescore.set(cacheKey, []); return []; }

  const live = raw.map(ev => ({
    source: 'thesportsdb',
    sport,
    eventId: ev.idEvent ? String(ev.idEvent) : null,
    homeTeam: String(ev.strHomeTeam || '').slice(0, 200),
    awayTeam: String(ev.strAwayTeam || '').slice(0, 200),
    homeScore: parseInt(ev.intHomeScore, 10),
    awayScore: parseInt(ev.intAwayScore, 10),
    progress: String(ev.strProgress || ev.strStatus || '').slice(0, 40),
    eventTime: ev.strEventTime || null,
  })).filter(e => e.eventId);
  _caches.livescore.set(cacheKey, live);
  return live;
}

// V2: Full schedule per team. Rijker dan v1's eventsnext.php (top-5 only).
async function fetchTeamFullSchedule(teamId) {
  const id = _validId(teamId);
  if (!id) return [];
  const cacheKey = `tsdb:full-schedule:${id}`;
  const cached = _caches.medium.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V2}/schedule/full/team/${encodeURIComponent(id)}`;
  const { data, called } = await _get(url, /*useV2=*/ true);
  if (!called) return [];
  const raw = data?.schedule || data?.events || [];
  if (!Array.isArray(raw)) { _caches.medium.set(cacheKey, []); return []; }

  const fixtures = raw.map(ev => ({
    source: 'thesportsdb',
    eventId: ev.idEvent ? String(ev.idEvent) : null,
    leagueId: ev.idLeague ? String(ev.idLeague) : null,
    homeTeam: String(ev.strHomeTeam || '').slice(0, 200),
    awayTeam: String(ev.strAwayTeam || '').slice(0, 200),
    date: ev.dateEvent || null,
    time: ev.strTime || null,
    venueId: ev.idVenue ? String(ev.idVenue) : null,
  })).filter(f => f.eventId);
  _caches.medium.set(cacheKey, fixtures);
  return fixtures;
}

// V2: Schedule per venue. Direction = 'next' | 'previous'.
async function fetchScheduleByVenue(venueId, direction = 'next') {
  const id = _validId(venueId);
  if (!id) return [];
  if (direction !== 'next' && direction !== 'previous') return [];
  const cacheKey = `tsdb:venue-schedule-${direction}:${id}`;
  const cached = _caches.hour.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE_V2}/schedule/${direction}/venue/${encodeURIComponent(id)}`;
  const { data, called } = await _get(url, /*useV2=*/ true);
  if (!called) return [];
  const raw = data?.schedule || data?.events || [];
  if (!Array.isArray(raw)) { _caches.hour.set(cacheKey, []); return []; }

  const fixtures = raw.map(ev => ({
    source: 'thesportsdb',
    eventId: ev.idEvent ? String(ev.idEvent) : null,
    homeTeam: String(ev.strHomeTeam || '').slice(0, 200),
    awayTeam: String(ev.strAwayTeam || '').slice(0, 200),
    date: ev.dateEvent || null,
    venueId: id,
  })).filter(f => f.eventId);
  _caches.hour.set(cacheKey, fixtures);
  return fixtures;
}

module.exports = {
  SOURCE_NAME,
  IS_PREMIUM,
  SPORT_MAP,
  healthCheck,
  // v12.5.12 + v12.6.x originele exports
  findTeamId,
  fetchH2HEvents,
  fetchTeamFormEvents,
  getUsage,
  // v12.7.0-pre1 nieuwe v1-endpoints
  fetchStandings,
  fetchEventLineup,
  fetchEventStats,
  fetchEventTimeline,
  fetchEventTV,
  fetchSchedulesByDate,
  fetchLeagueNext,
  fetchLeaguePast,
  fetchVenue,
  fetchTeamRoster,
  // v12.7.0-pre1 nieuwe v2-endpoints (premium-only, fail-soft op free)
  fetchLivescore,
  fetchTeamFullSchedule,
  fetchScheduleByVenue,
  // Test-hooks (v12.6.1+): consistent met andere source-adapters.
  _clearCache: () => { for (const c of Object.values(_caches)) c.clear(); },
  _breaker: breaker,
  _resetUsage: () => { _callsToday = 0; _callsTodayDate = null; },
};
