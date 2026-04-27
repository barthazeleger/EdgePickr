'use strict';

// v12.5.12: TheSportsDB adapter — H2H events voor football. Free test-key
// werkt zonder account voor diagnose; premium-key (TSDB_API_KEY env var)
// vereist voor productie-throughput.
//
// Endpoints:
//   GET /api/v1/json/{KEY}/searchteams.php?t={NAME}      → team-lookup
//   GET /api/v1/json/{KEY}/lookuph2h.php?id={A}&id2={B}  → H2H events
//
// Free test-key "3" heeft strikte rate-limits + sommige endpoints disabled.
// Productie: $5/maand patreon-key via thesportsdb.com voor v2 API access.
//
// Coverage-claim: alle major sports + breed scope competities (volgens
// thesportsdb.com docs). Aanvulling op sofascore/fotmob die op datacenter-
// IP's geblokkeerd kunnen zijn.

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
const BASE = `https://${HOST}/api/v1/json/${API_KEY}`;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h: H2H/form changes rarely
const RATE_LIMIT_MS = 1500;                 // ~0.67 req/sec — conservatiever dan sofascore voor free-key

const rl = new RateLimiter(RATE_LIMIT_MS);
const cache = new TTLCache(CACHE_TTL_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 5,
  minCooldownMs: 5 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
}));

// TheSportsDB wil simpele Accept-header, geen browser-spoofing. Eigen Origin
// is niet nodig (publieke open-API).
const EXTRA_HEADERS = {
  'Accept': 'application/json',
};

async function _get(url) {
  if (!isSourceEnabled(SOURCE_NAME)) return null;
  if (!breaker.allow()) return null;
  await rl.acquire();
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: EXTRA_HEADERS, returnDetails: true,
  });
  if (!details || !details.ok || !details.data) {
    breaker.onFailure(details?.error || 'unknown');
    return null;
  }
  breaker.onSuccess();
  return details.data;
}

async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  // Pingt searchteams met bekende naam — minimale endpoint-coverage check.
  const url = `${BASE}/searchteams.php?t=${encodeURIComponent('Arsenal')}`;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: EXTRA_HEADERS, returnDetails: true,
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
  };
}

// Find team ID by name. TheSportsDB doet alleen exact-ish search; we doen
// zelf normalisatie om partial matches te accepteren.
async function findTeamId(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  const cacheKey = `tsdb:team:${normalizeTeamKey(teamName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const query = teamName.slice(0, 120);
  const url = `${BASE}/searchteams.php?t=${encodeURIComponent(query)}`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.teams)) {
    cache.set(cacheKey, null);
    return null;
  }

  // Filter op football (strSport = 'Soccer' in TSDB-terminologie).
  const normTarget = normalizeTeamKey(teamName);
  const candidates = data.teams.filter(t => {
    if (!t || !t.idTeam || !t.strTeam) return false;
    if (t.strSport && t.strSport !== 'Soccer') return false;
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
// Premium-key vereist voor v2 API; free-key heeft toegang tot v1 lookuph2h.
async function fetchH2HEvents(teamAName, teamBName) {
  if (!teamAName || !teamBName) return [];
  const cacheKey = `tsdb:h2h:${normalizeTeamKey(teamAName)}|${normalizeTeamKey(teamBName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const tA = await findTeamId(teamAName);
  if (!tA) { cache.set(cacheKey, []); return []; }
  const tB = await findTeamId(teamBName);
  if (!tB) { cache.set(cacheKey, []); return []; }

  const url = `${BASE}/lookuph2h.php?id=${encodeURIComponent(tA.id)}&id2=${encodeURIComponent(tB.id)}`;
  const data = await _get(url);
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
      sport: 'football',
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
  healthCheck,
  findTeamId,
  fetchH2HEvents,
  fetchTeamFormEvents,
};
