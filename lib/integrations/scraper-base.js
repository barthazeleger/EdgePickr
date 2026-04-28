'use strict';

// v10.9.0: Shared primitives voor scraping/external-API modules.
// - safeFetch: timeout + AbortController + SSRF-guard + JSON parse met fail-safe
// - RateLimiter: per-bron throttling zodat we geen rate-limits van upstream triggeren
// - TTLCache: in-memory LRU met TTL (H2H + form data veranderen zelden)
// - ALLOWED_HOSTS per source: URL-allowlist tegen onbedoelde calls
//
// Design keuzes:
// - Module-level state per bron is OK (één proces, geen races tussen bronnen)
// - Alle errors → null/empty return, nooit exception naar caller (scan mag niet breken)
// - Geen credentials of user-input in logs
// - User-Agent polite maar non-identifying

const DEFAULT_TIMEOUT_MS = 7000;
// v10.9.2: humanized User-Agent — echte Chrome macOS string. Pool van verse UAs
// roteert per call via pickUserAgent() om tracking-fingerprints te verspreiden.
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
function pickUserAgent() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }
const DEFAULT_USER_AGENT = UA_POOL[0];

// Complete set browser-headers die Chrome 128 daadwerkelijk stuurt bij fetch().
// Host-specific Referer/Origin wordt per source toegevoegd via extraHeaders.
function browserHeaders() {
  return {
    'User-Agent': pickUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Connection': 'keep-alive',
  };
}

// SSRF-bescherming. Lijst van regex patronen die NIET mogen worden geraakt.
const SSRF_BLOCKLIST = [
  /\blocalhost\b/i,
  /\b127\.\d+\.\d+\.\d+\b/,
  /\b10\.\d+\.\d+\.\d+\b/,
  /\b192\.168\.\d+\.\d+\b/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+\b/,
  /\b169\.254\.\d+\.\d+\b/,
  /\b0\.0\.0\.0\b/,
  /\[::1\]/,
  /\[fc00:/i,
  /\[fe80:/i,
];

function isUrlSafe(url, allowedHosts = []) {
  if (typeof url !== 'string' || url.length > 2000) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (SSRF_BLOCKLIST.some(re => re.test(u.host))) return false;
  if (allowedHosts.length && !allowedHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return false;
  return true;
}

// v10.9.2: diagnostics mode. Bij `returnDetails=true` geeft safeFetch een
// object terug { ok, status, error, data } i.p.v. data/null. Zo kan admin
// endpoint zien WAAROM een bron faalt (403 anti-bot vs 404 endpoint-change
// vs timeout).
async function safeFetch(url, {
  timeout = DEFAULT_TIMEOUT_MS,
  headers = {},
  userAgent = null,
  allowedHosts = [],
  asText = false,
  returnDetails = false,
  extraHeaders = {},
} = {}) {
  if (!isUrlSafe(url, allowedHosts)) {
    return returnDetails ? { ok: false, status: 0, error: 'url_not_safe' } : null;
  }
  if (typeof fetch !== 'function') {
    return returnDetails ? { ok: false, status: 0, error: 'no_fetch_api' } : null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    // v10.9.2: full browser-header set (Chrome 128 op macOS). UA rotated per call.
    // sec-ch-ua + sec-fetch-* headers doen anti-bot detectors geloven dat we
    // een echte browser zijn. Per-source kan extraHeaders Referer/Origin
    // overriden — dan zetten we ook sec-fetch-site naar "same-origin".
    const base = browserHeaders();
    if (userAgent) base['User-Agent'] = userAgent;
    if (asText) base.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    const r = await fetch(url, {
      headers: {
        ...base,
        ...extraHeaders,
        ...headers,
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    // v12.7.0-pre2: respHeaders extractie zodat callers (e.g. OddsAPI quota
    // tracking via x-requests-remaining) authoritative state uit de response
    // kunnen lezen. Backwards-compat: alleen meegestuurd bij returnDetails=true,
    // bestaande callers zonder headers-veld blijven onveranderd werken.
    const respHeaders = {};
    if (returnDetails && r.headers && typeof r.headers.forEach === 'function') {
      r.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
    }
    if (!r.ok) {
      return returnDetails ? { ok: false, status: r.status, error: `http_${r.status}`, headers: respHeaders } : null;
    }
    if (asText) {
      const txt = await r.text();
      return returnDetails ? { ok: true, status: r.status, data: txt, headers: respHeaders } : txt;
    }
    const text = await r.text();
    if (!text) return returnDetails ? { ok: false, status: r.status, error: 'empty_body', headers: respHeaders } : null;
    try {
      const data = JSON.parse(text);
      return returnDetails ? { ok: true, status: r.status, data, headers: respHeaders } : data;
    } catch {
      return returnDetails ? { ok: false, status: r.status, error: 'json_parse_fail', headers: respHeaders } : null;
    }
  } catch (e) {
    const err = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message || 'fetch_error');
    return returnDetails ? { ok: false, status: 0, error: err.slice(0, 100) } : null;
  } finally {
    clearTimeout(timer);
  }
}

class RateLimiter {
  // v10.9.2: humanized jitter. Fixed 1s intervallen = botachtig patroon.
  // Nu: min ± 30% random offset zodat requests niet op kloktik-kadans komen.
  constructor(minIntervalMs = 1000, jitterPct = 0.3) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.jitterPct = Math.max(0, Math.min(1, jitterPct));
    this.last = 0;
    this.queue = Promise.resolve();
  }
  acquire() {
    const prev = this.queue;
    this.queue = prev.then(async () => {
      const jitter = this.minIntervalMs * this.jitterPct * (Math.random() * 2 - 1);
      const target = this.minIntervalMs + jitter;
      const wait = target - (Date.now() - this.last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
    });
    return this.queue;
  }
}

class TTLCache {
  constructor(ttlMs = 60 * 60 * 1000, maxEntries = 2000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: refresh insertion order
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  set(key, v) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { at: Date.now(), v });
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// Normalize team name voor matching: lowercase, trim, strip diacritics + suffix-tokens.
// Used door search-helpers zodat "Bromley FC" en "Bromley" dezelfde key geven.
function normalizeTeamKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|sv|sk|bk|ac|as|us|cd|ca|fk|nk|hk|ks|kf|gks|fk|rc|rcd|rs|bsc|bvb)\b/g, '')
    .replace(/\b(united|city|town|club|football|soccer)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function safeName(s) {
  return typeof s === 'string' ? s.slice(0, 200) : '';
}

// v10.9.0: Circuit breaker per source. Na N opeenvolgende failures wordt de
// bron automatisch uitgeschakeld (cooldown) zodat kapotte scraper de scan niet
// doorlopend vertraagt. Herstart zichzelf na cooldown en retry-health-check.
//
// States: 'closed' (healthy) → 'open' (gefaald, cooldown) → 'half-open' (proberen)
// → bij success: closed; bij fail: open (cooldown verdubbeld tot max).
class CircuitBreaker {
  constructor({ name, failureThreshold = 5, successThreshold = 2,
                minCooldownMs = 5 * 60 * 1000, maxCooldownMs = 60 * 60 * 1000 } = {}) {
    this.name = name || 'anonymous';
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.minCooldownMs = minCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.state = 'closed';
    this.fails = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.currentCooldownMs = minCooldownMs;
    this.totalCalls = 0;
    this.totalFails = 0;
    this.lastError = null;
    this.lastSuccess = null;
  }
  _transition(to) {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    _emitBreakerState(this, from, to);
  }
  // Call this BEFORE each fetch. Returns false → skip (bron in cooldown).
  allow() {
    this.totalCalls++;
    if (this.state === 'closed') return true;
    const sinceOpen = Date.now() - this.openedAt;
    if (this.state === 'open' && sinceOpen >= this.currentCooldownMs) {
      this._transition('half-open');
      this.successes = 0;
      return true;
    }
    return this.state !== 'open';
  }
  // Call this AFTER a successful fetch (non-null response).
  onSuccess() {
    this.lastSuccess = Date.now();
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this._transition('closed');
        this.fails = 0;
        this.currentCooldownMs = this.minCooldownMs;
      }
    } else if (this.state === 'closed') {
      this.fails = 0;
    }
  }
  // Call this AFTER a failed fetch (null / exception).
  onFailure(err) {
    this.totalFails++;
    this.lastError = err ? String(err).slice(0, 200) : 'unknown';
    if (this.state === 'half-open') {
      this._transition('open');
      this.openedAt = Date.now();
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.currentCooldownMs * 2);
      return;
    }
    this.fails++;
    if (this.fails >= this.failureThreshold) {
      this._transition('open');
      this.openedAt = Date.now();
      // Keep current cooldown (reset to min when recently closed)
    }
  }
  status() {
    return {
      name: this.name,
      state: this.state,
      fails: this.fails,
      totalCalls: this.totalCalls,
      totalFails: this.totalFails,
      cooldownMs: this.state === 'open' ? this.currentCooldownMs - (Date.now() - this.openedAt) : 0,
      lastError: this.lastError,
      lastSuccess: this.lastSuccess,
    };
  }
  // Manual override (admin-force reset)
  reset() {
    this.state = 'closed';
    this.fails = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.currentCooldownMs = this.minCooldownMs;
    this.lastError = null;
  }
}

// Registry om alle breakers via naam op te vragen (voor admin endpoint).
const BREAKERS = new Map();
const _stateChangeCallbacks = [];
function registerBreaker(breaker) {
  BREAKERS.set(breaker.name, breaker);
  return breaker;
}
function getBreaker(name) { return BREAKERS.get(name); }
function allBreakerStatuses() {
  return Array.from(BREAKERS.values()).map(b => b.status());
}
// v10.9.0: callbacks krijgen notificatie bij breaker state-change (closed→open,
// half-open→closed, etc). Gebruikt voor Supabase inbox notificaties zodat user
// bij elke source-uitval/herstel iets in de inbox ziet.
function onBreakerStateChange(cb) {
  if (typeof cb === 'function') _stateChangeCallbacks.push(cb);
}
function _emitBreakerState(breaker, from, to) {
  for (const cb of _stateChangeCallbacks) {
    try { cb({ name: breaker.name, from, to, status: breaker.status() }); } catch { /* swallow */ }
  }
}

// Wrapped fetch die circuit breaker respecteert.
// Geeft null terug als breaker open is of fetch faalt. Update breaker state.
async function fetchViaBreaker(url, fetchOpts, breaker) {
  if (breaker && !breaker.allow()) return null;
  try {
    const result = await safeFetch(url, fetchOpts);
    if (result === null || result === undefined) {
      if (breaker) breaker.onFailure('null_response');
      return null;
    }
    if (breaker) breaker.onSuccess();
    return result;
  } catch (e) {
    if (breaker) breaker.onFailure(e && e.message);
    return null;
  }
}

// Runtime-config: per-source enabled flag. Kan via admin endpoint gewijzigd
// zonder redeploy (in-memory). Bij restart reset op DEFAULT_ENABLED.
const _sourceEnabled = new Map();
function isSourceEnabled(name) {
  if (!_sourceEnabled.has(name)) return false;   // default off tot admin aanzet
  return _sourceEnabled.get(name) === true;
}
function setSourceEnabled(name, enabled) {
  _sourceEnabled.set(name, !!enabled);
}
function listSources() {
  return Array.from(_sourceEnabled.entries()).map(([name, enabled]) => ({ name, enabled }));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  isUrlSafe,
  safeFetch,
  fetchViaBreaker,
  RateLimiter,
  TTLCache,
  CircuitBreaker,
  registerBreaker,
  getBreaker,
  allBreakerStatuses,
  onBreakerStateChange,
  isSourceEnabled,
  setSourceEnabled,
  listSources,
  normalizeTeamKey,
  safeName,
};
