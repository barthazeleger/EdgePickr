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
// Endpoints (V1, beschikbaar voor alle keys incl. test '3'):
//   GET /api/v1/json/{KEY}/searchteams.php?t={NAME}      → team-lookup
//   GET /api/v1/json/{KEY}/lookuph2h.php?id={A}&id2={B}  → H2H events
//
// Endpoints (V2, premium-only, X-API-KEY header):
//   GET /api/v2/json/livescore/{sport}                   → livescore per sport
//   GET /api/v2/json/lookupevent/{eventId}               → uitgebreid event-detail
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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h: H2H/form changes rarely
// Premium = 100 req/min ≈ 600ms interval, free '3'-key = strikter ~1500ms.
const RATE_LIMIT_MS = IS_PREMIUM ? 600 : 1500;

const rl = new RateLimiter(RATE_LIMIT_MS);
const cache = new TTLCache(CACHE_TTL_MS);
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
});

function _strSportFor(sport) { return SPORT_MAP[sport] || 'Soccer'; }

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

// fetchTeamFormEvents: TheSportsDB heeft `eventslast.php?id=` voor recent
// events per team. Niet implemented want sofascore + fotmob dekken al
// form-events voor de aggregator; TheSportsDB is hier puur als h2h-aanvulling.
async function fetchTeamFormEvents() { return []; }

module.exports = {
  SOURCE_NAME,
  IS_PREMIUM,
  SPORT_MAP,
  healthCheck,
  findTeamId,
  fetchH2HEvents,
  fetchTeamFormEvents,
  getUsage,
  // Test-hooks (v12.6.1): consistent met andere source-adapters.
  _clearCache: () => cache.clear(),
  _breaker: breaker,
  _resetUsage: () => { _callsToday = 0; _callsTodayDate = null; },
};
