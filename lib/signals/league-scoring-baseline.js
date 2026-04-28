'use strict';

/**
 * v15.0.2 · League scoring baseline (TSDB fetchLeaguePast).
 *
 * Bayesian-shrunk gemiddelde-goals/match per liga, gebruikt als additieve
 * OU-prior signal wanneer team-form data thin is. Doel: bij dunne H2H samples
 * niet uitsluitend op pre-match team stats vertrouwen, maar ook de league-
 * brede scoring environment laten meewegen.
 *
 * Pure math, geen fetch — caller geeft events-array (typisch via TSDB
 * `fetchLeaguePast(leagueId)`). Helper retourneert null als sample te thin
 * is (n<3) zodat caller de signal kan skippen.
 */

const DEFAULT_PRIOR_GOALS_PER_MATCH = 2.65;
const DEFAULT_PRIOR_K = 30;
const DEFAULT_LINE = 2.5;
const SIGNAL_MAGNITUDE_CAP = 0.02; // ±2pp prob nudge max

/**
 * @param {Array} events - elements with `homeScore` / `awayScore` (numbers, NaN allowed)
 * @param {object} [opts]
 *   - prior: liga-prior gem. goals (default 2.65)
 *   - priorK: shrinkage-strength (default 30 — bij n=30 telt prior nog 50% mee)
 *   - line: OU lijn (default 2.5)
 *   - minSample: minimum events met geldige scores voor signal (default 3)
 * @returns {null | {avgGoals, sample, prior, shrunk, signal, nudge}}
 *   - signal: short string "+0.8%_league_ou_baseline" voor signal-array
 *   - nudge: numerieke prob-delta voor caller (caps op ±SIGNAL_MAGNITUDE_CAP)
 */
function computeLeagueBaseline(events, opts = {}) {
  const prior = Number.isFinite(opts.prior) && opts.prior > 0 ? opts.prior : DEFAULT_PRIOR_GOALS_PER_MATCH;
  const priorK = Number.isFinite(opts.priorK) && opts.priorK > 0 ? opts.priorK : DEFAULT_PRIOR_K;
  const line = Number.isFinite(opts.line) && opts.line > 0 ? opts.line : DEFAULT_LINE;
  const minSample = Number.isFinite(opts.minSample) && opts.minSample > 0 ? opts.minSample : 3;

  if (!Array.isArray(events) || events.length === 0) return null;

  let sumGoals = 0;
  let n = 0;
  for (const ev of events) {
    if (!ev) continue;
    const h = Number(ev.homeScore);
    const a = Number(ev.awayScore);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    if (h < 0 || a < 0) continue;
    sumGoals += h + a;
    n++;
  }
  if (n < minSample) return null;

  const avgGoals = sumGoals / n;
  const shrunk = (sumGoals + prior * priorK) / (n + priorK);

  // Soft nudge: hoe sterker de league avg afwijkt van line, hoe groter de
  // duw. Schaalfactor 0.012 zodat bij 1 goal verschil (shrunk=3.5 vs line=2.5)
  // de nudge ~+1.2pp wordt; bij 2 goals verschil reaches we de cap.
  const rawDelta = shrunk - line;
  const cappedNudge = Math.max(-SIGNAL_MAGNITUDE_CAP, Math.min(SIGNAL_MAGNITUDE_CAP, rawDelta * 0.012));
  const nudgePct = +(cappedNudge * 100).toFixed(2);

  return {
    sample: n,
    avgGoals: +avgGoals.toFixed(2),
    prior: +prior.toFixed(2),
    priorK,
    shrunk: +shrunk.toFixed(2),
    line,
    nudge: cappedNudge,
    // Signal-naam bevat "over" zodat lib/picks.js relevantSignals-filter
    // (regel 169-174) het signaal als OU-relevant herkent en mee laat tellen
    // in signalContrib voor de extreme_divergence audit.
    signal: `league_baseline_over_under:${nudgePct >= 0 ? '+' : ''}${nudgePct.toFixed(2)}%`,
  };
}

module.exports = {
  computeLeagueBaseline,
  DEFAULT_PRIOR_GOALS_PER_MATCH,
  DEFAULT_PRIOR_K,
  DEFAULT_LINE,
  SIGNAL_MAGNITUDE_CAP,
};
