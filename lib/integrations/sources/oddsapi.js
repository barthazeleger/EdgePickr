'use strict';

// v12.7.0-pre2 (v13.0 Phase 2): The Odds API adapter — free-tier (500 req/maand)
// odds-feed met Bet365/Pinnacle/Unibet/William Hill/DraftKings coverage. Bedoeld
// als 2e bron-laag tussen TSDB Premium (primair) en api-sports (3e fallback)
// voor odds-data, met focus op sharp bookmakers (Pinnacle) en EU-execution
// books (Bet365/Unibet) die EdgePickr's doctrine onderscheidt.
//
// Free-tier quota (500/maand) is krap: 3 scans/dag × 30d = 90 scans, dus ~5-6
// calls per scan. Per-call cache + degrade-naar-shadow-only bij >450/maand
// voorkomen quota-exhaustion.
//
// Endpoints (alle v4):
//   GET /v4/sports                                  — sport list (geen quota)
//   GET /v4/sports/{key}/odds                       — odds per sport (1 quota)
//   GET /v4/sports/{key}/scores?daysFrom=1          — scores (geen quota)
//   GET /v4/sports/{key}/events                     — fixture list (geen quota)
//
// Auth: api-key via querystring `?apiKey=...` (niet header). Vereist
// `process.env.ODDSAPI_KEY`. Zonder key → adapter inactief, healthCheck
// returnt healthy=null, alle methods returnen [].
//
// Bookmaker-normalisatie: OddsAPI gebruikt eigen keys (`bet365`, `pinnacle`,
// `unibet_eu`, etc.). EdgePickr's interne bookie-namen volgen UI-conventie
// (`Bet365`, `Pinnacle`, `Unibet`). _normalizeBookieKey() maapt over.
//
// Market-normalisatie: OddsAPI's `h2h` → EdgePickr's `1X2` (sporten met draw)
// of `ML` (no-draw sporten). `totals` → `OU{N}`, `spreads` → `AH`. EdgePickr
// canonical market-types in `lib/markets.js`; deze adapter mapt naar daar.

const {
  RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled, safeFetch,
} = require('../scraper-base');

const SOURCE_NAME = 'oddsapi';
const HOST = 'api.the-odds-api.com';
const ALLOWED = [HOST];
const BASE = `https://${HOST}/v4`;

// v12.7.0-pre2: env-var ODDSAPI_KEY canonical, ODDSPAPI_KEY (typo, pre-existed
// in render.yaml v12.6.0) als backwards-compat fallback. Beide hetzelfde
// effect; nieuwe deployments gebruiken ODDSAPI_KEY.
const API_KEY = process.env.ODDSAPI_KEY || process.env.ODDSPAPI_KEY || '';
const HAS_KEY = API_KEY.length > 0;

// Free tier 500 req/maand (per OddsAPI docs). 90 scans/maand = ~5 odds-calls
// per scan veilig. Bij >450 calls in 30 rolling dagen → shadow-only mode.
const MONTHLY_QUOTA = 500;
const QUOTA_SOFT_LIMIT = 450;

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
  // Sports-list endpoint heeft geen quota-cost, ideaal voor health-ping.
  const url = `${BASE}/sports?apiKey=${encodeURIComponent(API_KEY)}`;
  const details = await safeFetch(url, {
    allowedHosts: ALLOWED, extraHeaders: HEADERS, returnDetails: true,
  });
  const latency = Date.now() - t0;
  const healthy = details && details.ok && Array.isArray(details.data);
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
    'La Liga':    'soccer_spain_la_liga',
    'Bundesliga': 'soccer_germany_bundesliga',
    'Serie A':    'soccer_italy_serie_a',
    'Ligue 1':    'soccer_france_ligue_one',
    'Eredivisie': 'soccer_netherlands_eredivisie',
    'CL':         'soccer_uefa_champs_league',
    'EL':         'soccer_uefa_europa_league',
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
  // handball, tennis, rugby, cricket sport-keys komen in Phase 4
});

function resolveOddsApiKey(sport, league) {
  const m = SPORT_KEY_MAP[sport];
  if (!m) return null;
  if (league && m[league]) return m[league];
  return m.default || null;
}

// ── PUBLIC METHODS ───────────────────────────────────────────────────────────

// List alle ondersteunde sporten in OddsAPI. Geen quota-cost.
async function fetchSports() {
  const cacheKey = 'oddsapi:sports';
  const cached = _caches.sports.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get('/sports', {}, { quotaCost: false });
  if (!called) return [];
  if (!Array.isArray(data)) { _caches.sports.set(cacheKey, []); return []; }

  const sports = data.map(s => ({
    source: 'oddsapi',
    key: String(s.key || '').slice(0, 60),
    title: String(s.title || '').slice(0, 80),
    group: String(s.group || '').slice(0, 60),
    active: !!s.active,
    hasOutrights: !!s.has_outrights,
  })).filter(s => s.key);
  _caches.sports.set(cacheKey, sports);
  return sports;
}

// Fixture/events list (geen quota-cost) per sport-key.
async function fetchEvents(sportKey) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const cacheKey = `oddsapi:events:${sportKey}`;
  const cached = _caches.events.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get(
    `/sports/${encodeURIComponent(sportKey)}/events`,
    {},
    { quotaCost: false }
  );
  if (!called) return [];
  if (!Array.isArray(data)) { _caches.events.set(cacheKey, []); return []; }

  const events = data.map(ev => ({
    source: 'oddsapi',
    eventId: String(ev.id || '').slice(0, 60),
    sportKey: String(ev.sport_key || sportKey).slice(0, 60),
    sportTitle: String(ev.sport_title || '').slice(0, 80),
    commenceTime: ev.commence_time || null,
    homeTeam: String(ev.home_team || '').slice(0, 200),
    awayTeam: String(ev.away_team || '').slice(0, 200),
  })).filter(e => e.eventId);
  _caches.events.set(cacheKey, events);
  return events;
}

// Scores per sport-key (geen quota-cost). daysFrom default 1 → laatste 24h
// finished + live games.
async function fetchScores(sportKey, daysFrom = 1) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const df = Number.isFinite(daysFrom) && daysFrom >= 1 && daysFrom <= 3 ? daysFrom : 1;
  const cacheKey = `oddsapi:scores:${sportKey}:${df}`;
  const cached = _caches.scores.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get(
    `/sports/${encodeURIComponent(sportKey)}/scores`,
    { daysFrom: df },
    { quotaCost: false }
  );
  if (!called) return [];
  if (!Array.isArray(data)) { _caches.scores.set(cacheKey, []); return []; }

  const scores = data.map(s => ({
    source: 'oddsapi',
    eventId: String(s.id || '').slice(0, 60),
    completed: !!s.completed,
    homeTeam: String(s.home_team || '').slice(0, 200),
    awayTeam: String(s.away_team || '').slice(0, 200),
    homeScore: _parseScore(s.scores, s.home_team),
    awayScore: _parseScore(s.scores, s.away_team),
    lastUpdate: s.last_update || null,
    commenceTime: s.commence_time || null,
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

// Odds per sport-key. **WEL quota-cost** (de hoofdfunctie). Markets default
// h2h+totals+spreads, regions default eu+uk (de markten waar EdgePickr op
// uitvoert), bookmakers default Bet365/Pinnacle/Unibet (canon-execution-set).
async function fetchOdds(sportKey, options = {}) {
  if (!sportKey || typeof sportKey !== 'string') return [];
  const {
    sport = null,                          // EdgePickr sport-naam voor _mapMarketKey
    regions = 'eu,uk',
    markets = 'h2h,totals,spreads',
    bookmakers = 'bet365,pinnacle,unibet_eu,williamhill',
    oddsFormat = 'decimal',
  } = options;
  // v12.7.0-pre2 audit P2: sport is optioneel maar nodig voor correcte
  // h2h→1X2/ML mapping. Zonder sport defaultt _mapMarketKey naar 'ML' (no-draw)
  // → voetbal-h2h zou onterecht ML krijgen. Caller moet sport meegeven; warn
  // 1x per process (niet per call) zodat misuse zichtbaar is in logs.
  if (!sport && !_warnedNoSport) {
    _warnedNoSport = true;
    console.warn('[oddsapi] fetchOdds zonder sport-option → h2h defaultt naar ML (geen 1X2). Caller moet sport meegeven.');
  }

  const cacheKey = `oddsapi:odds:${sportKey}:${regions}:${markets}:${bookmakers}`;
  const cached = _caches.odds.get(cacheKey);
  if (cached !== undefined) return cached;

  const { data, called } = await _get(
    `/sports/${encodeURIComponent(sportKey)}/odds`,
    { regions, markets, bookmakers, oddsFormat },
    { quotaCost: true }
  );
  if (!called) return [];
  if (!Array.isArray(data)) { _caches.odds.set(cacheKey, []); return []; }

  const out = [];
  for (const event of data) {
    if (!event?.id || !Array.isArray(event.bookmakers)) continue;
    for (const bm of event.bookmakers) {
      const bookieName = _normalizeBookieKey(bm?.key);
      if (!bookieName || !Array.isArray(bm.markets)) continue;
      for (const mk of bm.markets) {
        const epMarket = _mapMarketKey(mk?.key, sport);
        if (!Array.isArray(mk?.outcomes)) continue;
        for (const oc of mk.outcomes) {
          const price = parseFloat(oc?.price);
          if (!Number.isFinite(price) || price <= 1.0 || price > 1000) continue;
          out.push({
            source: 'oddsapi',
            eventId: String(event.id).slice(0, 60),
            commenceTime: event.commence_time || null,
            homeTeam: String(event.home_team || '').slice(0, 200),
            awayTeam: String(event.away_team || '').slice(0, 200),
            bookie: bookieName,
            market: epMarket,
            marketRaw: String(mk?.key || '').slice(0, 30),
            selection: String(oc.name || '').slice(0, 200),
            line: oc.point != null ? parseFloat(oc.point) : null,
            price,
            lastUpdate: bm.last_update || null,
          });
        }
      }
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
  fetchEvents,
  fetchScores,
  fetchOdds,
  // Test-hooks (consistent met TSDB-adapter v12.6.1 pattern)
  _clearCache: () => { for (const c of Object.values(_caches)) c.clear(); },
  _breaker: breaker,
  _normalizeBookieKey,
  _mapMarketKey,
  _resetUsage: () => { _quotaUsed = 0; _quotaRemaining = MONTHLY_QUOTA; _quotaUpdatedAt = null; _warnedNoSport = false; },
};
