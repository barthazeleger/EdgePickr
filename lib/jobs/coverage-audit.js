'use strict';

const { sendOperatorNotification } = require('../notifications');

/**
 * v15.4 · Coverage-audit job (PLAN §5.1). Telt welke van de geconfigureerde
 * ligas (over alle 6 sporten) in een rolling window picks produceerden, en
 * logt dormant ligas naar de operator-inbox als read-only `coverage_insight`.
 *
 * Pure helper-laag: geen scheduler, geen netwerk-fetch buiten Supabase. De
 * scheduler in lib/runtime/maintenance-schedulers.js wraps deze functie in
 * een dagelijks tick + dedup zodat operator niet 7× per week dezelfde lijst
 * krijgt.
 *
 * Coverage-bron: `pick_candidates.created_at` in de window, gejoined op
 * `fixtures.league_id` / `league_name`. Dat dekt zowel passed-filters picks
 * als shadow/rejected — voor coverage gaat het om "is deze liga überhaupt
 * gezien", niet "is hier een pick uit gerold".
 */

async function collectSeenFixtureIds({ supabase, sinceIso, pageSize = 1000, maxRows = 50000 }) {
  const seen = new Set();
  let from = 0;
  while (seen.size < maxRows) {
    const { data, error } = await supabase
      .from('pick_candidates')
      .select('fixture_id')
      .gte('created_at', sinceIso)
      .not('fixture_id', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message || 'pick_candidates_read_failed');
    if (!data || data.length === 0) break;
    for (const r of data) if (r.fixture_id != null) seen.add(r.fixture_id);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return seen;
}

async function collectLeagueIdsAndNames({ supabase, fixtureIds, chunkSize = 500 }) {
  const ids = new Set();
  const names = new Set();
  if (!fixtureIds || fixtureIds.size === 0) return { ids, names };
  const list = Array.from(fixtureIds);
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('fixtures')
      .select('id, league_id, league_name')
      .in('id', chunk);
    if (error) throw new Error(error.message || 'fixtures_read_failed');
    for (const f of (data || [])) {
      if (f?.league_id != null) ids.add(Number(f.league_id));
      if (f?.league_name) names.add(String(f.league_name).toLowerCase().trim());
    }
  }
  return { ids, names };
}

function classifyLeagues({ leagues, seenLeagueIds, seenLeagueNames }) {
  const dormant = [];
  let totalCount = 0;
  let activeCount = 0;
  for (const [sport, list] of Object.entries(leagues || {})) {
    for (const lg of (Array.isArray(list) ? list : [])) {
      totalCount++;
      const lcName = String(lg?.name || '').toLowerCase().trim();
      const idMatch = lg?.id != null && seenLeagueIds.has(Number(lg.id));
      const nameMatch = lcName && seenLeagueNames.has(lcName);
      if (idMatch || nameMatch) activeCount++;
      else dormant.push({ sport, key: lg?.key || null, name: lg?.name || null, id: lg?.id ?? null });
    }
  }
  return { totalCount, activeCount, dormant };
}

async function runCoverageAudit({ supabase, leagues, daysWindow = 90 }) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('runCoverageAudit: missing supabase');
  }
  if (!leagues || typeof leagues !== 'object') {
    throw new Error('runCoverageAudit: missing leagues');
  }
  const sinceIso = new Date(Date.now() - daysWindow * 86400000).toISOString();
  const fixtureIds = await collectSeenFixtureIds({ supabase, sinceIso });
  const { ids: seenLeagueIds, names: seenLeagueNames } = await collectLeagueIdsAndNames({ supabase, fixtureIds });
  const { totalCount, activeCount, dormant } = classifyLeagues({ leagues, seenLeagueIds, seenLeagueNames });
  return {
    daysWindow,
    runAtMs: Date.now(),
    fixturesSeen: fixtureIds.size,
    leaguesTotal: totalCount,
    leaguesActive: activeCount,
    dormantLeagues: dormant,
  };
}

function formatDormantSummary(result) {
  if (!result || !Array.isArray(result.dormantLeagues)) return null;
  const { dormantLeagues, leaguesTotal, leaguesActive, daysWindow } = result;
  const top = dormantLeagues.slice(0, 12)
    .map(l => `${l.name || l.key || `id=${l.id}`}${l.sport ? ` (${l.sport})` : ''}`)
    .join(' · ');
  const more = dormantLeagues.length > 12 ? ` · +${dormantLeagues.length - 12} meer` : '';
  return `${leaguesActive}/${leaguesTotal} ligas leverden picks in laatste ${daysWindow}d. Dormant (${dormantLeagues.length}): ${top}${more}`;
}

async function postCoverageInsight({ supabase, result, sendPush = null }) {
  const summary = formatDormantSummary(result);
  if (!summary) return { ok: false, error: 'no_summary' };
  return sendOperatorNotification({
    supabase,
    category: 'coverage_insight',
    type: 'coverage_insight',
    title: `🗺️ Coverage-audit · ${result.dormantLeagues.length} dormant`,
    body: summary,
    sendPush,
  });
}

module.exports = {
  runCoverageAudit,
  formatDormantSummary,
  postCoverageInsight,
  classifyLeagues,
};
