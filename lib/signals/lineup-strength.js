'use strict';

/**
 * v15.0.12 · Lineup-strength signal (TSDB lookuplineup.php).
 *
 * Pure helper. Mapt een lineup-array (TSDB getLineups output) naar een
 * "compleetheids-score" tussen 0 en 1, plus een soft moneyline-nudge.
 *
 * Logica:
 *  - Lineups beschikbaar < 90min vóór kickoff = sterke confidence-boost
 *  - Hoog aandeel reserves/onbekende namen = "team fielding reserves" risico
 *  - Geen lineup beschikbaar = neutraal (geen signal, returnt null)
 *
 * Caller bepaalt of timing (kickoff-window) past — pure helper kijkt alleen
 * naar de inhoud van het lineup-object.
 */

const SIGNAL_MAGNITUDE_CAP = 0.01;       // ±1pp moneyline-prob nudge
const STARTERS_EXPECTED_FOOTBALL = 11;
const STARTERS_EXPECTED_HOCKEY = 6;
const STARTERS_EXPECTED_BASKETBALL = 5;

function _expectedStarters(sport) {
  switch (sport) {
    case 'football': return STARTERS_EXPECTED_FOOTBALL;
    case 'hockey':   return STARTERS_EXPECTED_HOCKEY;
    case 'basketball': return STARTERS_EXPECTED_BASKETBALL;
    default: return STARTERS_EXPECTED_FOOTBALL;
  }
}

/**
 * @param {Array} lineup - TSDB lineup rows van fetchEventLineup
 * @param {object} [opts]
 *   - sport: 'football' | 'hockey' | 'basketball'
 *   - team: 'home' | 'away' (filter; default: alle)
 *   - minMinutesBeforeKickoff: caller-validated, alleen voor logging
 * @returns {null | {score, sample, knownStarters, signal}}
 */
function computeLineupStrength(lineup, opts = {}) {
  if (!Array.isArray(lineup) || lineup.length === 0) return null;
  const sport = opts.sport || 'football';
  const expected = _expectedStarters(sport);
  const teamFilter = opts.team ? String(opts.team).toLowerCase() : null;

  // TSDB lineup-row shape: {strPosition, strPlayer, strTeam, strHome, …}.
  // Helper kan ook genormaliseerde rijen accepteren (player, position, team, isStarter).
  const knownPlayers = [];
  for (const row of lineup) {
    if (!row) continue;
    const player = String(row.player || row.strPlayer || '').trim();
    const teamSide = String(row.team || row.strTeam || row.side || '').toLowerCase();
    const isStarter = (row.isStarter !== undefined)
      ? !!row.isStarter
      : !/sub|reserve|bench/i.test(String(row.position || row.strPosition || ''));
    if (!player) continue;
    if (teamFilter && teamSide && !teamSide.includes(teamFilter)) continue;
    if (!isStarter) continue;
    knownPlayers.push(player);
  }

  if (knownPlayers.length === 0) return null;

  const score = Math.min(1, knownPlayers.length / expected);
  // Nudge: hoe vollediger het lineup, hoe meer we model-confidence laten staan.
  // Bij score = 1 → 0 nudge (model-prob als-is). Bij score < 0.7 →
  // negatieve nudge richting markt-baseline (model minder vertrouwen).
  const confidenceShortfall = Math.max(0, 0.7 - score);
  const rawNudge = Math.min(SIGNAL_MAGNITUDE_CAP, confidenceShortfall * 0.02);
  // Vermijd -0 bij confidenceShortfall = 0 (zodat strictEqual(0) werkt).
  const nudge = rawNudge === 0 ? 0 : -rawNudge;
  const nudgePct = +(nudge * 100).toFixed(2);

  return {
    score: +score.toFixed(2),
    sample: knownPlayers.length,
    expected,
    nudge,
    // Naam bevat "lineup" — niet automatisch in OU-filter. Picks.js OU-filter
    // (regel 169-174) gebruikt /(weather|poisson|team_stats|over|under|goals|o2\.5|u2\.5)/.
    // Lineup is een 1X2/ML-relevant signaal, niet OU. Het signaal valt onder
    // de "geen-keyword-match" tak (3e arm van filter, default true op
    // niet-BTTS/niet-OU markets). Dus 1X2/ML markts kunnen het wel gebruiken.
    signal: `lineup_strength:${nudgePct >= 0 ? '+' : ''}${nudgePct.toFixed(2)}%`,
  };
}

module.exports = {
  computeLineupStrength,
  SIGNAL_MAGNITUDE_CAP,
  STARTERS_EXPECTED_FOOTBALL,
  STARTERS_EXPECTED_HOCKEY,
  STARTERS_EXPECTED_BASKETBALL,
};
