'use strict';

/**
 * EdgePickr v12.5.1 — Conviction-route doctrine evaluator.
 *
 * Vergelijkt CLV + winrate per pick-track (`conviction_route=true` vs
 * `conviction_route=false`) over een rollend venster. Geeft een
 * decision-aanbeveling die de wekelijkse scheduler / het admin-endpoint
 * gebruikt om de doctrine-pivot van v12.5.0 datagedreven te tunen.
 *
 * Drempels (conservatief):
 *   - n < minSamples → 'hold' (te weinig bewijs)
 *   - clvDiff < -2pp AND winrateDiff < -5pp → 'revert' (auto-toepasbaar)
 *   - clvDiff >= 0 AND |winrateDiff| <= 3pp → 'promote_pending_approval'
 *   - anders → 'hold' (mixed evidence)
 *
 * Doctrine: auto-revert in conservatieve richting (rollback bij slecht
 * bewijs) wel, maar manual approval voor verder loosenen. Sluit aan bij
 * "liever 0 picks dan 1 valse edge" — variance-illusie van 100 settled
 * rijen mag niet leiden tot ongecontroleerde gate-loosening.
 *
 * Pure helper: gebruikt alleen supabase-client. Geen schedule-state, geen
 * inbox-write — caller wikkelt de notify/auto-toggle.
 */

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MIN_SAMPLES = 100;
const REVERT_CLV_DIFF_THRESHOLD = -0.02;     // conviction CLV ≥2pp slechter
const REVERT_WINRATE_DIFF_THRESHOLD = -0.05; // conviction winrate ≥5pp slechter
const PROMOTE_WINRATE_PARITY_THRESHOLD = 0.03; // |diff| ≤3pp = parity

function summarize(rows) {
  const settled = rows.filter(r => r && (r.result === 'W' || r.result === 'L'));
  const wins = settled.filter(r => r.result === 'W').length;
  const winrate = settled.length ? wins / settled.length : null;
  const withClv = rows.filter(r => r && r.clv_pct != null && Number.isFinite(Number(r.clv_pct)));
  const avgClv = withClv.length
    ? withClv.reduce((s, r) => s + Number(r.clv_pct), 0) / withClv.length
    : null;
  return {
    n: rows.length,
    settled: settled.length,
    winrate: winrate != null ? +winrate.toFixed(4) : null,
    avgClv: avgClv != null ? +avgClv.toFixed(4) : null,
  };
}

/**
 * Evalueer de conviction-route doctrine over een rollend venster.
 *
 * @param {object} params
 *   - supabase: required, Supabase service-role client.
 *   - windowDays: lookback (default 14).
 *   - minSamples: minimum conviction-track samples voor een non-hold beslissing (default 100).
 * @returns {Promise<object>} { decision, reason, conviction, edge, clvDiff, winrateDiff, action?, error? }
 */
async function evaluateConvictionDoctrine({ supabase, windowDays = DEFAULT_WINDOW_DAYS, minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    return { decision: 'hold', reason: 'no_supabase', conviction: null, edge: null };
  }
  const sinceIso = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  let rows = null;
  try {
    const { data, error } = await supabase.from('pick_candidates')
      .select('conviction_route, result, clv_pct, created_at')
      .gte('created_at', sinceIso)
      .in('result', ['W', 'L', 'P']);
    if (error) {
      return { decision: 'hold', reason: 'query_failed', error: error.message || String(error), conviction: null, edge: null };
    }
    rows = data || [];
  } catch (e) {
    return { decision: 'hold', reason: 'query_threw', error: e?.message || String(e), conviction: null, edge: null };
  }

  const conviction = summarize(rows.filter(r => r.conviction_route === true));
  const edge = summarize(rows.filter(r => r.conviction_route !== true));

  if (conviction.n < minSamples) {
    return {
      decision: 'hold', reason: 'insufficient_conviction_samples',
      conviction, edge,
      windowDays, minSamples,
    };
  }

  const clvDiff = (conviction.avgClv ?? 0) - (edge.avgClv ?? 0);
  const winrateDiff = (conviction.winrate ?? 0) - (edge.winrate ?? 0);

  if (clvDiff < REVERT_CLV_DIFF_THRESHOLD && winrateDiff < REVERT_WINRATE_DIFF_THRESHOLD) {
    return {
      decision: 'revert',
      reason: 'underperform_threshold',
      conviction, edge,
      clvDiff: +clvDiff.toFixed(4),
      winrateDiff: +winrateDiff.toFixed(4),
      action: 'set OPERATOR.conviction_route_disabled=true (mkP epGap valt terug naar v12.4.x voor sigCount≥6)',
      windowDays, minSamples,
    };
  }

  if (clvDiff >= 0 && Math.abs(winrateDiff) <= PROMOTE_WINRATE_PARITY_THRESHOLD) {
    return {
      decision: 'promote_pending_approval',
      reason: 'on_par_or_better',
      conviction, edge,
      clvDiff: +clvDiff.toFixed(4),
      winrateDiff: +winrateDiff.toFixed(4),
      action: 'operator review: overweeg sigCount≥6 → 0.015 verder loosenen (handmatig in lib/picks.js epGap-formule)',
      windowDays, minSamples,
    };
  }

  return {
    decision: 'hold',
    reason: 'mixed_evidence',
    conviction, edge,
    clvDiff: +clvDiff.toFixed(4),
    winrateDiff: +winrateDiff.toFixed(4),
    windowDays, minSamples,
  };
}

/**
 * Bouw een leesbare regel voor scan-log / inbox-body uit de evaluatie-output.
 */
function formatDoctrineDecision(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return '';
  const { decision, reason, conviction, edge, clvDiff, winrateDiff, action } = evaluation;
  const fmt = (v, suffix = '') =>
    v == null ? '—' : `${(v * 100).toFixed(1)}${suffix}`;
  const head = decision === 'revert' ? '🛑 REVERT'
             : decision === 'promote_pending_approval' ? '🟢 PROMOTE-CANDIDATE'
             : '⏸️ HOLD';
  const lines = [];
  lines.push(`${head} (${reason})`);
  if (conviction && edge) {
    lines.push(`  conviction: n=${conviction.n}, settled=${conviction.settled}, winrate=${fmt(conviction.winrate, '%')}, avgCLV=${fmt(conviction.avgClv, '%')}`);
    lines.push(`  edge: n=${edge.n}, settled=${edge.settled}, winrate=${fmt(edge.winrate, '%')}, avgCLV=${fmt(edge.avgClv, '%')}`);
  }
  if (clvDiff != null) lines.push(`  ΔCLV=${clvDiff >= 0 ? '+' : ''}${(clvDiff * 100).toFixed(2)}pp · ΔWinrate=${winrateDiff >= 0 ? '+' : ''}${(winrateDiff * 100).toFixed(2)}pp`);
  if (action) lines.push(`  action: ${action}`);
  return lines.join('\n');
}

module.exports = {
  evaluateConvictionDoctrine,
  formatDoctrineDecision,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MIN_SAMPLES,
  REVERT_CLV_DIFF_THRESHOLD,
  REVERT_WINRATE_DIFF_THRESHOLD,
  PROMOTE_WINRATE_PARITY_THRESHOLD,
};
