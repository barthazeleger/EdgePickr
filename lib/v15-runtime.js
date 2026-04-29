'use strict';

const { normalizeTeamName, teamMatchScore } = require('./model-math');

function tsdbStandingsRowsToFootballStats(rows = []) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row.teamName || '').trim();
    if (!name) continue;
    const played = Number(row.played) > 0 ? Number(row.played) : 1;
    out[name.toLowerCase()] = {
      form: row.form || '',
      goalsFor: +(Number(row.goalsFor || 0) / played).toFixed(2),
      goalsAgainst: +(Number(row.goalsAgainst || 0) / played).toFixed(2),
      teamId: row.teamId || null,
      rank: row.rank || 0,
      homeGPG: +(Number(row.goalsFor || 0) / played).toFixed(2),
      homeGAPG: +(Number(row.goalsAgainst || 0) / played).toFixed(2),
      awayGPG: +(Number(row.goalsFor || 0) / played).toFixed(2),
      awayGAPG: +(Number(row.goalsAgainst || 0) / played).toFixed(2),
      source: 'thesportsdb',
    };
  }
  return out;
}

function lookupTeamStats(statsMap = {}, teamName) {
  if (!statsMap || !teamName) return null;
  const exact = statsMap[String(teamName).toLowerCase()];
  if (exact) return exact;
  let best = null;
  let bestScore = 0;
  for (const [key, value] of Object.entries(statsMap)) {
    const score = teamMatchScore(key, teamName);
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return bestScore >= 80 ? best : null;
}

function mergeStatsWithFallback(primary = {}, fallback = {}) {
  return { ...(fallback || {}), ...(primary || {}) };
}

function collectBookmakerOutcomeQuotes(bookmakers = [], marketKey, outcomeName, point = null) {
  const out = [];
  for (const bk of Array.isArray(bookmakers) ? bookmakers : []) {
    const market = bk.markets?.find(m => m.key === marketKey);
    if (!market || !Array.isArray(market.outcomes)) continue;
    for (const outcome of market.outcomes) {
      if (outcome.name !== outcomeName) continue;
      if (point != null && Math.abs(Number(outcome.point) - Number(point)) >= 0.01) continue;
      const price = Number(outcome.price);
      if (!Number.isFinite(price) || price <= 1) continue;
      out.push({ bookie: bk.title || bk.name || 'Unknown', price, point: outcome.point ?? null });
    }
  }
  return out;
}

function fixtureMatchesEvent(event, homeName, awayName, kickoffMs, opts = {}) {
  if (!event || !homeName || !awayName) return false;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 150;
  const timeToleranceMs = Number.isFinite(opts.timeToleranceMs) ? opts.timeToleranceMs : 6 * 60 * 60 * 1000;
  const direct = teamMatchScore(event.homeTeam || event.home || '', homeName)
    + teamMatchScore(event.awayTeam || event.away || '', awayName);
  const swapped = teamMatchScore(event.homeTeam || event.home || '', awayName)
    + teamMatchScore(event.awayTeam || event.away || '', homeName);
  if (Math.max(direct, swapped) < minScore) return false;
  const eventTime = Date.parse(event.commenceTime || event.startTime || event.date || '');
  if (Number.isFinite(kickoffMs) && Number.isFinite(eventTime) && Math.abs(eventTime - kickoffMs) > timeToleranceMs) {
    return false;
  }
  return true;
}

function summarizeSharpAnchor(mergedOdds, homeName, awayName, kickoffMs) {
  const quotes = Array.isArray(mergedOdds?.quotes) ? mergedOdds.quotes : [];
  const matched = quotes.filter(q => fixtureMatchesEvent(q, homeName, awayName, kickoffMs));
  if (!matched.length) {
    let best = null;
    for (const q of quotes) {
      const direct = teamMatchScore(q.homeTeam || q.home || '', homeName)
        + teamMatchScore(q.awayTeam || q.away || '', awayName);
      const swapped = teamMatchScore(q.homeTeam || q.home || '', awayName)
        + teamMatchScore(q.awayTeam || q.away || '', homeName);
      const score = Math.max(direct, swapped);
      if (!best || score > best.score) {
        best = {
          score,
          homeTeam: q.homeTeam || q.home || '',
          awayTeam: q.awayTeam || q.away || '',
          commenceTime: q.commenceTime || q.startTime || q.date || null,
          bookie: q.bookie || null,
          market: q.market || null,
        };
      }
    }
    return {
      unmatchedQuoteCount: quotes.length,
      bestUnmatched: best && best.score > 0 ? best : null,
    };
  }
  const sharp = matched.filter(q => /pinnacle|betfair|exchange|circa|sbobet/i.test(String(q.bookie || '')));
  const selected = sharp.length ? sharp : matched;
  return {
    source: 'oddspapi',
    mode: sharp.length ? 'sharp_reference' : 'market_reference',
    sources: mergedOdds.sources || [],
    quoteCount: matched.length,
    sharpQuoteCount: sharp.length,
    markets: [...new Set(matched.map(q => q.market).filter(Boolean))].slice(0, 12),
    bookies: [...new Set(matched.map(q => q.bookie).filter(Boolean))].slice(0, 12),
    sample: selected.slice(0, 12).map(q => ({
      bookie: q.bookie,
      market: q.market,
      selection: q.selection,
      line: q.line ?? null,
      price: q.price,
    })),
  };
}

function isLiveFixture(events, homeName, awayName, kickoffMs) {
  return (Array.isArray(events) ? events : []).some(ev => fixtureMatchesEvent(ev, homeName, awayName, kickoffMs, {
    timeToleranceMs: 12 * 60 * 60 * 1000,
  }));
}

function sourceAttributionBase(sport, details = {}) {
  return {
    sport,
    apiSports: details.apiSports || {},
    thesportsdb: details.thesportsdb || {},
    oddspapi: details.oddspapi || {},
  };
}

function formSummaryToStats(baseStats, formSummary, teamId = null) {
  if (!formSummary) return baseStats || null;
  return {
    ...(baseStats || {}),
    form: baseStats?.form || formSummary.form || '',
    goalsFor: Number.isFinite(formSummary.gfPerGame) ? formSummary.gfPerGame : baseStats?.goalsFor,
    goalsAgainst: Number.isFinite(formSummary.gaPerGame) ? formSummary.gaPerGame : baseStats?.goalsAgainst,
    homeGPG: baseStats?.homeGPG ?? formSummary.gfPerGame,
    homeGAPG: baseStats?.homeGAPG ?? formSummary.gaPerGame,
    awayGPG: baseStats?.awayGPG ?? formSummary.gfPerGame,
    awayGAPG: baseStats?.awayGAPG ?? formSummary.gaPerGame,
    teamId: baseStats?.teamId || teamId,
    source: baseStats?.source || 'thesportsdb',
  };
}

module.exports = {
  tsdbStandingsRowsToFootballStats,
  lookupTeamStats,
  mergeStatsWithFallback,
  collectBookmakerOutcomeQuotes,
  fixtureMatchesEvent,
  summarizeSharpAnchor,
  isLiveFixture,
  sourceAttributionBase,
  formSummaryToStats,
  _normalizeTeamName: normalizeTeamName,
};
