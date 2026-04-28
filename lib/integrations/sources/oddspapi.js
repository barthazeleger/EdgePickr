'use strict';

// v13.0.2 (v13.0 Phase 2 refactor): OddsPapi.io adapter — free-tier (250 req/
// maand) odds-feed met 350+ bookmakers via één API: 9 sharp books (Pinnacle/
// SBOBet/Circa), 17 US (DraftKings/FanDuel/BetMGM/Caesars), 20 UK (Bet365/
// Betfair/William Hill/Paddy Power/Ladbrokes/Coral), 8 Brazil, 8 Asian, 9
// crypto/offshore (1xBet/Stake/BC.Game), 6 betting exchanges (Betfair Ex/
// Polymarket/Kalshi/Matchbook). Bedoeld als 2e bron-laag tussen TSDB Premium
// (primair) en api-sports (3e fallback).
//
// Free-tier quota (250/maand) is krap: 3 scans/dag × 30d = 90 scans, dus ~2-3
// calls per scan. Per-call cache + degrade-naar-shadow-only bij >225/maand
// voorkomen quota-exhaustion.
//
// API spec (uit https://oddspapi.io/docs):
//   Base URL:  https://api.oddspapi.io
//   Auth:      ?apiKey={KEY} querystring
//   Endpoints (alle v4):
//     GET /v4/sports                  — sport-list (1 req)
//     GET /v4/bookmakers              — bookmaker-list (1 req)
//     GET /v4/tournaments             — leagues/tournaments (1 req)
//     GET /v4/fixtures                — meerdere events
//     GET /v4/fixture                 — enkel event
//     GET /v4/markets                 — markt-types
//     GET /v4/odds                    — current odds
//     GET /v4/odds-by-tournaments     — odds gefilterd op leagues
//     GET /v4/historical-odds         — historische data
//     GET /v4/scores                  — match-results
//     GET /v4/account                 — quota-state
//
// Eerdere versie (v12.7.0-pre2 t/m v13.0.1) bouwde tegen the-odds-api.com.
// Renamed in v13.0.2 nadat scan toonde HTTP 401 → operator confirmed dat de
// service oddspapi.io is, niet the-odds-api.com.

const {
  RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled, safeFetch,
} = require('../scraper-base');

const SOURCE_NAME = 'oddspapi';
const HOST = 'api.oddspapi.io';
const ALLOWED = [HOST];
const BASE = `https://${HOST}/v4`;

// v13.0.2: env-var ODDSPAPI_KEY canonical (matches service-naam oddspapi.io).
// ODDSAPI_KEY (uit v12.7.0-pre2 toen ik verkeerd aannemde) blijft werken als
// backwards-compat fallback voor deployments die die naam al gebruikten.
const API_KEY = process.env.ODDSPAPI_KEY || process.env.ODDSAPI_KEY || '';
const HAS_KEY = API_KEY.length > 0;

// Free tier 250 req/maand (per oddspapi.io homepage). 90 scans/maand = ~2-3
// odds-calls per scan veilig. Bij >225 calls in 30 rolling dagen → shadow-only.
const MONTHLY_QUOTA = 250;
const QUOTA_SOFT_LIMIT = 225;

// Rate-limiter: niet zo strikt als TSDB want OddsAPI heeft geen per-minuut-cap,
// alleen monthly. 1.5s tussen calls is conservatief om burst-pieken te vermijden
// in samengestelde scans.
const RATE_LIMIT_MS = 1500;

// Per-endpoint TTL-buckets (zelfde patroon als TSDB-adapter v12.7.0-pre1).
const _caches = {
  sports:    new TTLCache(24 * 60 * 60 * 1000,    50),  // sports list: dagelijks
  odds:      new TTLCache(5 * 60 * 1000,         500),  // odds: 5min in scan-window
  scores:    new TTLCache(2 * 60 * 1000,         500),  // scores: 2min (live)
  events:    new TTLCache(60 * 60 * 1000,        500),  // events/fixtures: 1h
};

const rl = new RateLimiter(RATE_LIMIT_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 5,
  minCooldownMs: 5 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
}));

// ── QUOTA TRACKING ───────────────────────────────────────────────────────────
// OddsAPI returnt `x-requests-remaining` + `x-requests-used` headers per call.
// Authoritative state komt dus van API zelf; lokale counter is fallback voor
// pre-emptive degradation tussen response-events.
let _quotaUsed = 0;
let _quotaRemaining = MONTHLY_QUOTA;
let _quotaUpdatedAt = null;
let _warnedNoSport = false;  // audit P2: één-malig warn over missing sport-option

function getUsage() {
  return {
    source: SOURCE_NAME,
    callsThisMonth: _quotaUsed,
    remaining: _quotaRemaining,
    monthlyQuota: MONTHLY_QUOTA,
    softLimit: QUOTA_SOFT_LIMIT,
    degraded: _quotaUsed >= QUOTA_SOFT_LIMIT,
    updatedAt: _quotaUpdatedAt,
    hasKey: HAS_KEY,
  };
}

function _isDegraded() {
  return _quotaUsed >= QUOTA_SOFT_LIMIT;
}

// ── HEADERS ──────────────────────────────────────────────────────────────────
const HEADERS = { 'Accept': 'application/json' };

// ── INTERNAL FETCH ───────────────────────────────────────────────────────────
// Zelfde {data, called} return-shape als TSDB-adapter (v12.6.1) zodat callers
// skip-cases NIET cachen. `quotaCost` flag voor caller om aan te geven of
// deze call wél tegen het maandquotum telt; default true (odds is paid call).
async function _get(path, params = {}, options = {}) {
  const { quotaCost = true } = options;
  if (!HAS_KEY) return { data: null, called: false };
  if (!isSourceEnabled(SOURCE_NAME)) return { data: null, called: false };
  if (!breaker.allow()) return { data: null, called: false };
  if (quotaCost && _isDegraded()) return { data: null, called: false, degraded: true };

  await rl.acquire();
  const qs = Object.entries({ apiKey: API_KEY, ...params })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: HEADERS, returnDetails: true,
  });
  if (!details || !details.ok || !details.data) {
    breaker.onFailure(details?.error || 'unknown');
    return { data: null, called: false };
  }
  breaker.onSuccess();
  // v12.7.0-pre2 audit P1 fix: quota-state monotonic update om race-conditie
  // te voorkomen waar concurrent responses out-of-order arriveren en stale
  // header-values nieuwere waardes overschrijven (e.g. used=76 arrives na
  // used=77, zou _quotaUsed laten regress naar 76).
  // Ook P1 fix: fallback-increment alleen als headers GEEN parseable
  // quota-fields bevatten (niet alleen 'als headers === undefined'). safeFetch
  // returnt nu altijd `headers: {}` (mogelijk leeg), dus oude `if (details.headers)`
  // truthy check faalde stilletjes voor lege headers.
  let parsedFromHeaders = false;
  const h = details.headers || {};
  const remaining = parseInt(h['x-requests-remaining'], 10);
  const used = parseInt(h['x-requests-used'], 10);
  if (Number.isFinite(used)) {
    // Monotonic: counter loopt nooit terug
    _quotaUsed = Math.max(_quotaUsed, used);
    parsedFromHeaders = true;
  }
  if (Number.isFinite(remaining)) {
    // Monotonic: remaining loopt nooit op
    _quotaRemaining = Math.min(_quotaRemaining, remaining);
    parsedFromHeaders = true;
  }
  if (parsedFromHeaders) {
    _quotaUpdatedAt = new Date().toISOString();
  } else if (quotaCost) {
    // Fallback: lokaal incrementeren als headers geen quota-velden hadden
    // (bv. oudere Node Response-polyfills zonder forEach, of non-OddsAPI
    // hosts die deze adapter zou kunnen hergebruiken).
    _quotaUsed++;
    _quotaRemaining = Math.max(0, MONTHLY_QUOTA - _quotaUsed);
    _quotaUpdatedAt = new Date().toISOString();
  }
  return { data: details.data, called: true };
}

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
async function healthCheck() {
  if (!HAS_KEY) return { source: SOURCE_NAME, healthy: null, disabled: true, reason: 'no_key' };
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  // /v4/sports endpoint = sport-list. v13.0.2: response-shape onbekend tot
  // eerste live-call; accepteer zowel `{ sports: [...] }`, `{ data: [...] }`
  // als top-level array (defensieve health-ping zonder over assumed shape).
  const url = `${BASE}/sports?apiKey=${encodeURIComponent(API_KEY)}`;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: HEADERS, returnDetails: true,
  });
  const latency = Date.now() - t0;
  const data = details?.data;
  const healthy = details && details.ok && data && (
    Array.isArray(data) ||
    Array.isArray(data.sports) ||
    Array.isArray(data.data) ||
    (typeof data === 'object' && Object.keys(data).length > 0)
  );
  if (!healthy) breaker.onFailure(details?.error || 'unknown');
  else breaker.onSuccess();
  return {
    source: SOURCE_NAME,
    healthy: !!healthy,
    latencyMs: latency,
    httpStatus: details?.status ?? 0,
    error: healthy ? null : (details?.error || 'unknown'),
    breaker: breaker.status(),
    quotaRemaining: _quotaRemaining,
    quotaUsed: _quotaUsed,
    degraded: _isDegraded(),
  };
}

// ── BOOKMAKER NORMALISATIE ───────────────────────────────────────────────────
// OddsAPI bookmaker-keys → EdgePickr canonical naam. Onbekende bookies vallen
// terug op title-case van de OddsAPI-key (bv. `betfair_ex_eu` → 'Betfair Ex Eu').
const BOOKIE_MAP = Object.freeze({
  bet365:        'Bet365',
  pinnacle:      'Pinnacle',
  unibet_eu:     'Unibet',
  unibet:        'Unibet',
  williamhill:   'William Hill',
  draftkings:    'DraftKings',
  fanduel:       'FanDuel',
  betfair_ex_eu: 'Betfair Exchange',
  betfair_ex_uk: 'Betfair Exchange',
  betfair:       'Betfair',
  ladbrokes_uk:  'Ladbrokes',
  paddypower:    'Paddy Power',
});

function _normalizeBookieKey(key) {
  if (!key || typeof key !== 'string') return null;
  if (BOOKIE_MAP[key]) return BOOKIE_MAP[key];
  // Title-case fallback voor onbekende keys
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ── MARKET NORMALISATIE ──────────────────────────────────────────────────────
// OddsAPI market-keys: `h2h` (head-to-head = ML / 1X2), `spreads` (handicap),
// `totals` (over/under), `outrights` (futures). EdgePickr canonical naming
// volgt `lib/markets.js` doctrine — beweegt naar EdgePickr-types per call.
//
// h2h-mapping is sport-afhankelijk: voetbal/handbal hebben draw, dus → '1X2';
// tennis/basketball/hockey/baseball/NFL hebben geen draw → 'ML'.
const SPORTS_WITH_DRAW = new Set(['football', 'handball', 'rugby']);

function _mapMarketKey(oddsApiKey, sport) {
  if (oddsApiKey === 'h2h') return SPORTS_WITH_DRAW.has(sport) ? '1X2' : 'ML';
  if (oddsApiKey === 'spreads') return 'AH';
  if (oddsApiKey === 'totals') return 'OU';
  if (oddsApiKey === 'outrights') return 'OUTRIGHT';
  return String(oddsApiKey || '').toUpperCase().slice(0, 20);
}

// ── SPORT-KEY MAPPING ────────────────────────────────────────────────────────
// EdgePickr sport + (optioneel) league → OddsAPI sport-key. Begin met top-
// leagues per sport; uitgebreid in Phase 4 voor tennis/rugby/cricket. Caller
// kan ook OddsAPI-key direct passen voor bekende keys (e.g. 'soccer_epl').
const SPORT_KEY_MAP = Object.freeze({
  football: {
    'EPL':        'soccer_epl',
    'Premier League': 'soccer_epl',
    'La Liga':    'soccer_spain_la_liga',
    'Bundesliga': 'soccer_germany_bundesliga',
    'Serie A':    'soccer_italy_serie_a',
    'Ligue 1':    'soccer_france_ligue_one',
    'Eredivisie': 'soccer_netherlands_eredivisie',
    'CL':         'soccer_uefa_champs_league',
    'Champions League': 'soccer_uefa_champs_league',
    'EL':         'soccer_uefa_europa_league',
    'Europa League': 'soccer_uefa_europa_league',
    'MLS':        'soccer_usa_mls',
    'default':    'soccer_epl',
  },
  basketball: {
    'NBA':        'basketball_nba',
    'EuroLeague': 'basketball_euroleague',
    'NCAA':       'basketball_ncaab',
    'default':    'basketball_nba',
  },
  hockey: {
    'NHL':        'icehockey_nhl',
    'KHL':        'icehockey_khl',
    'default':    'icehockey_nhl',
  },
  baseball: {
    'MLB':        'baseball_mlb',
    'NPB':        'baseball_npb',
    'default':    'baseball_mlb',
  },
  'american-football': {
    'NFL':        'americanfootball_nfl',
    'NCAA':       'americanfootball_ncaaf',
    'default':    'americanfootball_nfl',
  },
  // v12.7.0-pre4 (Phase 4): Tennis/Rugby/Cricket sport-keys. OddsAPI splitst
  // tennis per tournament (ATP/WTA/ITF), rugby per league/competition, cricket
  // per format (test/ODI/T20/IPL/BBL). Default kiest het meest-actieve format.
  tennis: {
    'ATP':         'tennis_atp_french_open',     // wisselt per actieve tournament; OddsAPI heeft per-event keys
    'WTA':         'tennis_wta_french_open',
    'Wimbledon':   'tennis_atp_wimbledon',
    'US Open':     'tennis_atp_us_open',
    'Australian Open': 'tennis_atp_aus_open',
    'default':     'tennis_atp_french_open',
  },
  rugby: {
    'NRL':              'rugbyleague_nrl',
    'Six Nations':      'rugbyunion_six_nations',
    'Premiership':      'rugbyunion_english_premiership',
    'Top 14':           'rugbyunion_french_top14',
    'Super Rugby':      'rugbyunion_super_rugby',
    'default':          'rugbyleague_nrl',
  },
  cricket: {
    'IPL':         'cricket_ipl',
    'BBL':         'cricket_big_bash',
    'Test':        'cricket_test_match',
    'ODI':         'cricket_odi',
    'T20':         'cricket_international_t20',
    'PSL':         'cricket_psl',
    'default':     'cricket_test_match',
  },
});

function resolveOddsApiKey(sport, league) {
  const m = SPORT_KEY_MAP[sport];
  if (!m) return null;
  if (league && m[league]) return m[league];
  return m.default || null;
}

// ── PUBLIC METHODS ───────────────────────────────────────────────────────────

// v13.0.2: response-shapes tussen OddsPapi endpoints zijn onbekend tot eerste
// live-call. Helper die top-level array, {data:[]}, {sports:[]}, {fixtures:[]}
// of {events:[]} accepteert om de meest voorkomende REST-conventies af te
// dekken zonder per endpoint te raden.
function _toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'sports', 'fixtures', 'events', 'odds', 'scores', 'results', 'items']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

// List alle ondersteunde sporten in OddsPapi. Geen quota-cost (per docs).
async function fetchSports() {
  const cacheKey = 'oddspapi:sports';
  const cached = _caches.sports.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get('/sports', {}, { quotaCost: false });
  if (!called) return [];
  const arr = _toArray(data);
  if (!arr.length) { _caches.sports.set(cacheKey, []); return []; }

  const sports = arr.map(s => ({
    source: 'oddspapi',
    key: String(s.key || s.id || s.slug || '').slice(0, 60),
    title: String(s.title || s.name || '').slice(0, 80),
    group: String(s.group || s.category || '').slice(0, 60),
    active: s.active !== false,
    hasOutrights: !!(s.has_outrights || s.hasOutrights),
  })).filter(s => s.key);
  _caches.sports.set(cacheKey, sports);
  return sports;
}

// Bookmaker-lijst (geen quota-cost). v13.0.2: nieuw t.o.v. oude adapter,
// OddsPapi heeft een aparte /v4/bookmakers endpoint.
async function fetchBookmakers() {
  const cacheKey = 'oddspapi:bookmakers';
  const cached = _caches.sports.get(cacheKey);  // hergebruik sports-bucket (24h TTL)
  if (cached !== undefined) return cached;

  const { data, called } = await _get('/bookmakers', {}, { quotaCost: false });
  if (!called) return [];
  const arr = _toArray(data);
  const bookies = arr.map(b => ({
    source: 'oddspapi',
    key: String(b.key || b.id || b.slug || '').slice(0, 60),
    title: String(b.title || b.name || '').slice(0, 80),
    region: String(b.region || b.country || '').slice(0, 40),
  })).filter(b => b.key);
  _caches.sports.set(cacheKey, bookies);
  return bookies;
}

// Fixture-list. OddsPapi: GET /v4/fixtures (geen quota-cost).
async function fetchEvents(sportKey) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const cacheKey = `oddspapi:events:${sportKey}`;
  const cached = _caches.events.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get('/fixtures', { sport: sportKey }, { quotaCost: false });
  if (!called) return [];
  const arr = _toArray(data);
  if (!arr.length) { _caches.events.set(cacheKey, []); return []; }

  const events = arr.map(ev => ({
    source: 'oddspapi',
    eventId: String(ev.id || ev.fixture_id || ev.event_id || '').slice(0, 60),
    sportKey: String(ev.sport_key || ev.sport || sportKey).slice(0, 60),
    sportTitle: String(ev.sport_title || ev.sport_name || '').slice(0, 80),
    commenceTime: ev.commence_time || ev.start_time || ev.startTime || null,
    homeTeam: String(ev.home_team || ev.homeTeam || ev.home || '').slice(0, 200),
    awayTeam: String(ev.away_team || ev.awayTeam || ev.away || '').slice(0, 200),
  })).filter(e => e.eventId);
  _caches.events.set(cacheKey, events);
  return events;
}

// Scores. OddsPapi: GET /v4/scores (geen quota-cost).
async function fetchScores(sportKey, daysFrom = 1) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const df = Number.isFinite(daysFrom) && daysFrom >= 1 && daysFrom <= 3 ? daysFrom : 1;
  const cacheKey = `oddspapi:scores:${sportKey}:${df}`;
  const cached = _caches.scores.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get('/scores', { sport: sportKey, daysFrom: df }, { quotaCost: false });
  if (!called) return [];
  const arr = _toArray(data);
  if (!arr.length) { _caches.scores.set(cacheKey, []); return []; }

  const scores = arr.map(s => ({
    source: 'oddspapi',
    eventId: String(s.id || s.fixture_id || s.event_id || '').slice(0, 60),
    completed: !!(s.completed || s.finished),
    homeTeam: String(s.home_team || s.home || '').slice(0, 200),
    awayTeam: String(s.away_team || s.away || '').slice(0, 200),
    homeScore: _parseScore(s.scores || s.score, s.home_team || s.home),
    awayScore: _parseScore(s.scores || s.score, s.away_team || s.away),
    lastUpdate: s.last_update || s.updated_at || null,
    commenceTime: s.commence_time || s.start_time || null,
  })).filter(x => x.eventId);
  _caches.scores.set(cacheKey, scores);
  return scores;
}

function _parseScore(scoresArr, teamName) {
  if (!Array.isArray(scoresArr) || !teamName) return null;
  const entry = scoresArr.find(x => x?.name === teamName);
  if (!entry) return null;
  const n = parseInt(entry.score, 10);
  return Number.isFinite(n) ? n : null;
}

// Odds. OddsPapi: GET /v4/odds (WEL quota-cost). Markets/bookmakers/sport
// als query-params. Defensieve parsing voor verschillende OddsPapi response-
// shapes (event-niveau nested, of platte odds-array).
async function fetchOdds(sportKey, options = {}) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const {
    sport = null,
    regions = 'eu,uk',
    markets = 'h2h,totals,spreads',
    bookmakers = 'bet365,pinnacle,unibet,williamhill',
    oddsFormat = 'decimal',
  } = options;
  if (!sport && !_warnedNoSport) {
    _warnedNoSport = true;
    console.warn('[oddspapi] fetchOdds zonder sport-option → h2h defaultt naar ML (geen 1X2). Caller moet sport meegeven.');
  }

  const cacheKey = `oddspapi:odds:${sportKey}:${regions}:${markets}:${bookmakers}`;
  const cached = _caches.odds.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get(
    '/odds',
    { sport: sportKey, regions, markets, bookmakers, oddsFormat },
    { quotaCost: true }
  );
  if (!called) return [];
  const arr = _toArray(data);
  if (!arr.length) { _caches.odds.set(cacheKey, []); return []; }

  const out = [];
  // Pattern A: event-niveau met nested bookmakers (OddsAPI-style)
  // Pattern B: platte odds-array (OddsPapi mogelijke alternative)
  for (const item of arr) {
    if (!item) continue;
    // Pattern A: item is event met item.bookmakers
    if (Array.isArray(item.bookmakers)) {
      const eventId = String(item.id || item.fixture_id || '').slice(0, 60);
      const commenceTime = item.commence_time || item.start_time || null;
      const homeTeam = String(item.home_team || item.home || '').slice(0, 200);
      const awayTeam = String(item.away_team || item.away || '').slice(0, 200);
      for (const bm of item.bookmakers) {
        const bookieName = _normalizeBookieKey(bm?.key || bm?.id || bm?.name);
        if (!bookieName || !Array.isArray(bm.markets)) continue;
        for (const mk of bm.markets) {
          const epMarket = _mapMarketKey(mk?.key || mk?.type, sport);
          if (!Array.isArray(mk?.outcomes)) continue;
          for (const oc of mk.outcomes) {
            const price = parseFloat(oc?.price || oc?.odds);
            if (!Number.isFinite(price) || price <= 1.0 || price > 2000) continue;
            out.push({
              source: 'oddspapi',
              eventId, commenceTime, homeTeam, awayTeam,
              bookie: bookieName,
              market: epMarket,
              marketRaw: String(mk?.key || mk?.type || '').slice(0, 30),
              selection: String(oc.name || oc.team || '').slice(0, 200),
              line: oc.point != null ? parseFloat(oc.point) : (oc.line != null ? parseFloat(oc.line) : null),
              price,
              lastUpdate: bm.last_update || bm.updated_at || null,
            });
          }
        }
      }
    } else if (item.bookmaker || item.book || item.bookie) {
      // Pattern B: platte odds-row met bookie-key direct op het item
      const price = parseFloat(item.price || item.odds || item.decimal);
      if (!Number.isFinite(price) || price <= 1.0 || price > 2000) continue;
      out.push({
        source: 'oddspapi',
        eventId: String(item.id || item.fixture_id || item.event_id || '').slice(0, 60),
        commenceTime: item.commence_time || item.start_time || null,
        homeTeam: String(item.home_team || item.home || '').slice(0, 200),
        awayTeam: String(item.away_team || item.away || '').slice(0, 200),
        bookie: _normalizeBookieKey(item.bookmaker || item.book || item.bookie),
        market: _mapMarketKey(item.market || item.market_key, sport),
        marketRaw: String(item.market || item.market_key || '').slice(0, 30),
        selection: String(item.name || item.outcome || item.selection || '').slice(0, 200),
        line: item.point != null ? parseFloat(item.point) : (item.line != null ? parseFloat(item.line) : null),
        price,
        lastUpdate: item.last_update || item.updated_at || null,
      });
    }
  }
  _caches.odds.set(cacheKey, out);
  return out;
}

module.exports = {
  SOURCE_NAME,
  HAS_KEY,
  SPORT_KEY_MAP,
  BOOKIE_MAP,
  healthCheck,
  getUsage,
  resolveOddsApiKey,
  fetchSports,
  fetchBookmakers,
  fetchEvents,
  fetchScores,
  fetchOdds,
  // Test-hooks (consistent met TSDB-adapter v12.6.1 pattern)
  _clearCache: () => { for (const c of Object.values(_caches)) c.clear(); },
  _breaker: breaker,
  _normalizeBookieKey,
  _mapMarketKey,
  _toArray,
  _resetUsage: () => { _quotaUsed = 0; _quotaRemaining = MONTHLY_QUOTA; _quotaUpdatedAt = null; _warnedNoSport = false; },
};
