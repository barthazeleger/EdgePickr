'use strict';

/**
 * EdgePickr v12.5.2 — Fixture-events fetcher voor paper-sweep settlement.
 *
 * Haalt finished fixtures over alle 6 sporten (today + yesterday) via
 * api-sports en bouwt een Map<`${sport}|${fixtureId}`, ev>. Het `ev`-shape
 * matcht wat `lib/runtime/results-checker.js resolveBetOutcome` verwacht
 * (home, away, scoreH, scoreA, regScoreH, regScoreA, halfH/A, inn1H/A,
 * status, sport).
 *
 * Niet-doel: live fixtures meenemen — paper-sweep settlt alleen finished
 * picks (`runPaperTradingSweep` filtert al op `kickoff_ms < cutoff`).
 *
 * Codestijl matcht `lib/runtime/check-open-bets.js` waar de zelfde
 * filter/map-logica al bestaat. Bewust niet gerefactored omdat
 * check-open-bets ook live-events nodig heeft en de extracted helper een
 * tweede subset-shape zou moeten ondersteunen — kleinere impact om de
 * mappings hier separaat te onderhouden.
 */

/**
 * @param {object} deps
 *   - afGet: async (host, path, params) → array
 * @returns {Promise<Map<string, object>>} key=`${sport}|${fixtureId}`
 */
async function fetchFinishedFixturesById({ afGet } = {}) {
  if (typeof afGet !== 'function') return new Map();

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const dayBefore = new Date(Date.now() - 2 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  // 3 dagen voor late-settling fixtures (postponed/playoff overruns).
  const dates = [today, yesterday, dayBefore];

  const fetchSport = (host, path) =>
    Promise.all(dates.map(d => afGet(host, path, { date: d }).catch(() => [])));

  const [
    fbDates, bbDates, hkDates, baDates, nflDates, hbDates,
  ] = await Promise.all([
    fetchSport('v3.football.api-sports.io', '/fixtures'),
    fetchSport('v1.basketball.api-sports.io', '/games'),
    fetchSport('v1.hockey.api-sports.io', '/games'),
    fetchSport('v1.baseball.api-sports.io', '/games'),
    fetchSport('v1.american-football.api-sports.io', '/games'),
    fetchSport('v1.handball.api-sports.io', '/games'),
  ]);

  const flat = (arr) => arr.flat();
  const out = new Map();

  // Football — `fixture.id` + `fixture.status.short` + `goals` + `teams`.
  const FB_FINISHED = new Set(['FT', 'AET', 'PEN']);
  for (const f of flat(fbDates)) {
    if (!f || !f.fixture || !FB_FINISHED.has(f.fixture?.status?.short)) continue;
    const id = f.fixture?.id;
    if (id == null) continue;
    out.set(`football|${id}`, {
      home:   f.teams?.home?.name || '',
      away:   f.teams?.away?.name || '',
      scoreH: f.goals?.home ?? 0,
      scoreA: f.goals?.away ?? 0,
      sport:  'football',
    });
  }

  // Basketball — `id` + `status.short` (FT/AOT) + `scores.home/away.total/quarter_*`.
  for (const g of flat(bbDates)) {
    if (!g || g.id == null) continue;
    const status = (g.status?.short || '').toUpperCase();
    if (status !== 'FT' && status !== 'AOT') continue;
    out.set(`basketball|${g.id}`, {
      home:   g.teams?.home?.name || '',
      away:   g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
      halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
      sport: 'basketball',
    });
  }

  // Hockey — FT/AOT/AP, met regulation-scope reconstructie via periods.first/second/third.
  const HK_FINISHED = new Set(['FT', 'AOT', 'AP']);
  for (const g of flat(hkDates)) {
    if (!g || g.id == null) continue;
    const status = (g.status?.short || '').toUpperCase();
    if (!HK_FINISHED.has(status)) continue;
    const p1H = g.periods?.first?.home ?? null;
    const p1A = g.periods?.first?.away ?? null;
    const p2H = g.periods?.second?.home ?? null;
    const p2A = g.periods?.second?.away ?? null;
    const p3H = g.periods?.third?.home ?? null;
    const p3A = g.periods?.third?.away ?? null;
    let regH, regA;
    if (p1H != null && p2H != null && p3H != null) {
      regH = p1H + p2H + p3H;
      regA = (p1A || 0) + (p2A || 0) + (p3A || 0);
    } else if (status === 'FT') {
      regH = g.scores?.home ?? 0; regA = g.scores?.away ?? 0;
    } else {
      // AOT/AP → reg-tied
      regH = regA = g.scores?.home ?? 0;
    }
    out.set(`hockey|${g.id}`, {
      home:   g.teams?.home?.name || '',
      away:   g.teams?.away?.name || '',
      scoreH: g.scores?.home ?? 0,
      scoreA: g.scores?.away ?? 0,
      regScoreH: regH, regScoreA: regA,
      status, p1H, p1A,
      sport: 'hockey',
    });
  }

  // Baseball — FT/AOT, plus optional 1st-inning scores (NRFI/YRFI).
  for (const g of flat(baDates)) {
    if (!g || g.id == null) continue;
    const status = (g.status?.short || '').toUpperCase();
    if (status !== 'FT' && status !== 'AOT') continue;
    out.set(`baseball|${g.id}`, {
      home:   g.teams?.home?.name || '',
      away:   g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      inn1H: g.scores?.home?.innings?.['1'] ?? g.scores?.home?.inning_1 ?? null,
      inn1A: g.scores?.away?.innings?.['1'] ?? g.scores?.away?.inning_1 ?? null,
      sport: 'baseball',
    });
  }

  // NFL — andere shape (`game.status` ipv `status` direct).
  for (const g of flat(nflDates)) {
    if (!g) continue;
    const id = g.game?.id ?? g.id;
    if (id == null) continue;
    const status = (g.game?.status?.short || g.status?.short || '').toUpperCase();
    if (status !== 'FT' && status !== 'AOT') continue;
    out.set(`american-football|${id}`, {
      home:   g.teams?.home?.name || '',
      away:   g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
      halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
      sport: 'american-football',
    });
  }

  // Handball — FT/AOT/AP, regulation-tied bij OT-finish.
  const HB_FINISHED = new Set(['FT', 'AOT', 'AP']);
  for (const g of flat(hbDates)) {
    if (!g || g.id == null) continue;
    const status = (g.status?.short || '').toUpperCase();
    if (!HB_FINISHED.has(status)) continue;
    const scoreH = g.scores?.home ?? 0;
    const scoreA = g.scores?.away ?? 0;
    let regH = scoreH, regA = scoreA;
    if (status === 'AOT' || status === 'AP') { regH = regA = scoreH; }
    out.set(`handball|${g.id}`, {
      home:   g.teams?.home?.name || '',
      away:   g.teams?.away?.name || '',
      scoreH, scoreA,
      regScoreH: regH, regScoreA: regA,
      status, sport: 'handball',
    });
  }

  return out;
}

module.exports = { fetchFinishedFixturesById };
