'use strict';

/**
 * EdgePickr Correlation Damping (discipline edge, roadmap punt 4).
 *
 * Dempt Kelly-stake op picks die in hetzelfde correlatie-cluster zitten:
 * zelfde league + zelfde operator-dag, of sterker: zelfde wedstrijd.
 *
 * v1-definitie (Codex-keuze):
 *   - same_league + same_day = correlated → second+ pick in cluster
 *     krijgt kelly × 0.5
 *   - same_fixture = strongest correlation → second+ pick in cluster
 *     krijgt kelly × 0.25
 *   - eerste (sterkste) pick in elk cluster behoudt volle kelly
 *
 * Module is pure: geen state, geen side-effects. Levert audit-trail per
 * gedempte pick zodat downstream (UI/logging) het "waarom" kan tonen.
 */

const { kellyToUnits } = require('./model-math');

const DAMP_SAME_LEAGUE_DAY = 0.5;
const DAMP_SAME_FIXTURE    = 0.25;

/**
 * Bepaal de "operator day" voor een kickoff-timestamp (Europe/Amsterdam
 * kalenderdag). Twee picks op dezelfde kalenderdag in dezelfde timezone
 * zijn qua bankroll-exposure gecorreleerd.
 */
function operatorDay(kickoff) {
  if (!kickoff) return null;
  try {
    const d = typeof kickoff === 'number' ? new Date(kickoff)
            : typeof kickoff === 'string' ? new Date(kickoff)
            : kickoff instanceof Date ? kickoff : null;
    if (!d || isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  } catch {
    return null;
  }
}

/**
 * Normaliseer league-naam voor clustering. Lowercase + trim zodat
 * "Premier League" en "premier league" dezelfde cluster vormen.
 */
function normalizeLeague(league) {
  return (league || '').toLowerCase().trim() || 'unknown';
}

/**
 * Normaliseer match-naam voor same-fixture detectie.
 */
function normalizeMatch(match) {
  return (match || '').toLowerCase().trim() || '';
}

/**
 * Groepeer picks op correlatie-clusters.
 *
 * Elke pick krijgt een `_correlationKey` = `${league}|${day}`.
 * Picks met dezelfde match-naam binnen een cluster markeren we als
 * `hasSameFixture`.
 *
 * @param {Array} picks - scan-output picks met { match, league, kickoff, ... }
 * @returns {Map<string, { picks: Pick[], hasSameFixture: boolean }>}
 */
function groupCorrelatedPicks(picks) {
  const clusters = new Map();
  for (const p of picks || []) {
    const sport = (p.sport || 'unknown').toLowerCase().trim();
    const league = normalizeLeague(p.league);
    const day = operatorDay(p.kickoff);
    const key = `${sport}|${league}|${day || 'unknown'}`;
    if (!clusters.has(key)) clusters.set(key, { picks: [], matchNames: new Set() });
    const c = clusters.get(key);
    c.picks.push(p);
    const matchNorm = normalizeMatch(p.match);
    if (matchNorm) c.matchNames.add(matchNorm);
  }
  // Bereken hasSameFixture per cluster
  for (const c of clusters.values()) {
    const matchCounts = new Map();
    for (const p of c.picks) {
      const m = normalizeMatch(p.match);
      if (m) matchCounts.set(m, (matchCounts.get(m) || 0) + 1);
    }
    c.hasSameFixture = [...matchCounts.values()].some(n => n > 1);
  }
  return clusters;
}

/**
 * Pas correlatie-demping toe op een picks-array. Muteert picks in-place
 * (kelly, units, expectedEur, strength) en voegt `correlationAudit` toe
 * als audit-trail. Picks worden NIET verwijderd — alleen gedempt.
 *
 * Binnen elk cluster: sorteer op expectedEur desc, eerste pick behoudt
 * volle kelly, rest wordt gedempt.
 *
 * @param {Array} picks
 * @returns {Array} dezelfde picks-array (gemuteerd)
 */
function applyCorrelationDamp(picks) {
  if (!Array.isArray(picks) || picks.length <= 1) return picks || [];

  const clusters = groupCorrelatedPicks(picks);

  for (const [key, cluster] of clusters) {
    if (cluster.picks.length <= 1) continue;

    // Sorteer binnen cluster: sterkste (hoogste expectedEur) eerst
    cluster.picks.sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0));

    for (let i = 0; i < cluster.picks.length; i++) {
      const p = cluster.picks[i];
      if (i === 0) {
        // Sterkste pick behoudt volle kelly — geen demping.
        p.correlationAudit = {
          reason: 'cluster_leader',
          clusterKey: key,
          clusterSize: cluster.picks.length,
          dampFactor: 1.0,
          positionInCluster: 1,
        };
        continue;
      }

      // Bepaal of deze specifieke pick same-fixture is met een eerdere pick
      const matchNorm = normalizeMatch(p.match);
      const isDuplicateFixture = matchNorm && cluster.picks
        .slice(0, i)
        .some(prev => normalizeMatch(prev.match) === matchNorm);
      const dampFactor = isDuplicateFixture ? DAMP_SAME_FIXTURE : DAMP_SAME_LEAGUE_DAY;

      const oldKelly = p.kelly || 0;
      const oldUnits = parseFloat(p.units) || 0;
      p.kelly = +(oldKelly * dampFactor).toFixed(6);
      p.units = kellyToUnits(p.kelly);
      const newUnits = parseFloat(p.units) || 0;
      const ratio = oldUnits > 0 ? newUnits / oldUnits : dampFactor;
      p.expectedEur = +(p.expectedEur * ratio).toFixed(2);
      p.strength = +(p.strength * ratio).toFixed(6);
      p.correlationAudit = {
        reason: isDuplicateFixture ? 'same_fixture' : 'same_league_same_day',
        clusterKey: key,
        clusterSize: cluster.picks.length,
        dampFactor,
        positionInCluster: i + 1,
        originalKelly: oldKelly,
        originalUnits: oldUnits,
      };
    }
  }
  return picks;
}

module.exports = {
  groupCorrelatedPicks,
  applyCorrelationDamp,
  operatorDay,
  DAMP_SAME_LEAGUE_DAY,
  DAMP_SAME_FIXTURE,
};
