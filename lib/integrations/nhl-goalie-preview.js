'use strict';

const CACHE_TTL_MS = 30 * 60 * 1000;
const previewCache = new Map();

function normalizeGoalieRow(row) {
  if (!row || typeof row !== 'object') return null;
  const savePct = Number(row.savePctg ?? row.savePct);
  const gaa = Number(row.goalsAgainstAvg ?? row.gaa);
  const gamesPlayed = Number(row.gamesPlayed || row.gamesStarted || 0);
  if (!isFinite(savePct) || !isFinite(gaa) || gamesPlayed <= 0) return null;
  return {
    playerId: row.playerId || null,
    teamId: row.teamId || null,
    name: row.name?.default || row.name || null,
    savePct,
    gaa,
    gamesPlayed,
    confirmed: Boolean(row.confirmed),
  };
}

function selectLikelyGoalie(rows = []) {
  const goalies = rows.map(normalizeGoalieRow).filter(Boolean)
    .sort((a, b) => (b.gamesPlayed - a.gamesPlayed) || (b.savePct - a.savePct));
  if (!goalies.length) return null;
  const primary = goalies[0];
  const backup = goalies[1] || null;
  const gamesGap = primary.gamesPlayed - (backup?.gamesPlayed || 0);
  const confidence = gamesGap >= 18 ? 'high' : gamesGap >= 8 ? 'medium' : 'low';
  const confidenceFactor = confidence === 'high' ? 1.0 : confidence === 'medium' ? 0.7 : 0.45;
  return {
    ...primary,
    confidence,
    confidenceFactor,
    backupGapGames: gamesGap,
    source: 'nhl-gamecenter-preview',
  };
}

function extractNhlGoaliePreview(payload) {
  const homeTeamId = payload?.homeTeam?.id || null;
  const awayTeamId = payload?.awayTeam?.id || null;
  const goalies = Array.isArray(payload?.matchup?.goalieComparison?.homeTeam?.leaders)
    || Array.isArray(payload?.matchup?.goalieComparison?.awayTeam?.leaders)
    ? [
        ...((payload?.matchup?.goalieComparison?.homeTeam?.leaders || []).map(g => ({ ...g, teamId: homeTeamId }))),
        ...((payload?.matchup?.goalieComparison?.awayTeam?.leaders || []).map(g => ({ ...g, teamId: awayTeamId }))),
      ]
    : [];
  const seasonGoalies = Array.isArray(payload?.goalieSeasonStats?.goalies)
    ? payload.goalieSeasonStats.goalies
    : [];
  const merged = seasonGoalies.length ? seasonGoalies : goalies;
  if (!merged.length) return null;
  return {
    source: 'nhl-gamecenter-preview',
    home: selectLikelyGoalie(merged.filter(g => g?.teamId === homeTeamId)),
    away: selectLikelyGoalie(merged.filter(g => g?.teamId === awayTeamId)),
  };
}

async function fetchNhlGoaliePreview(gameId) {
  if (!gameId) return null;
  const cacheKey = String(gameId);
  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    // v11.3.23 C1: safeFetch is 2-arg (url, options) en returnt parsed data of null,
    // geen Response-object. Eerdere 3-arg call + resp.ok + resp.json() was effectief
    // stuk — goalie-preview data kwam niet binnen. Reviewer Codex #2 vond dit.
    const { safeFetch } = require('./scraper-base');
    const data = await safeFetch(`https://api-web.nhle.com/v1/gamecenter/${encodeURIComponent(gameId)}/landing`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EdgePickr/10.x' },
      allowedHosts: ['api-web.nhle.com'],
    });
    if (!data) {
      previewCache.set(cacheKey, { at: Date.now(), value: null });
      return null;
    }
    const value = extractNhlGoaliePreview(data);
    previewCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    previewCache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}

function _clearCache() {
  previewCache.clear();
}

module.exports = {
  selectLikelyGoalie,
  extractNhlGoaliePreview,
  fetchNhlGoaliePreview,
  _clearCache,
};
