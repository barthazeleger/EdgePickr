'use strict';

/**
 * v14.0 Phase C: data-tunable parameter resolvers.
 *
 * Voorheen waren deze parameters hardcoded in diverse modules:
 *   BTTS_H2H_PRIOR, BTTS_H2H_PRIOR_K       (lib/picks.js:343-344)
 *   MIN_EP                                  (lib/config.js:99)
 *   NHL_OT_HOME_SHARE                       (lib/model-math.js:20)
 *   MODEL_MARKET_DIVERGENCE_THRESHOLD       (lib/model-math.js:31)
 *
 * Migratie naar calib.json (zie calibration-store.js DEFAULT_CALIB) maakt ze
 * runtime-tunable zonder code-redeploy. Operator kan via admin-endpoint
 * tunen; auto-tune-loops kunnen ze zelf updaten op basis van settled-bets.
 *
 * Doctrine: alle resolvers fail-soft op default-value bij ontbrekende calib-key.
 * Defaults matchen exact de pre-migratie hardcoded-waardes zodat migratie
 * gedrag-neutraal is bij eerste deploy.
 */

// Defaults match pre-v14.0 hardcoded constants
const DEFAULT_BTTS_PRIOR_RATE = 0.52;
const DEFAULT_BTTS_PRIOR_K    = 8;
const DEFAULT_MIN_EP          = 0.52;
const DEFAULT_NHL_OT_HOME     = 0.52;
const DEFAULT_DIVERGENCE      = 0.07;
const DEFAULT_SIGNAL_THRESHOLDS = Object.freeze({
  killMinN: 50,
  killEdgeClvPct: -1.5,
  killAvgClvPct: -0.5,
  promoteMinN: 50,
  promoteEdgeClvPct: 0.75,
  promoteAvgClvPct: 0,
  brierMuteN90: 50,
  brierMuteDrift: 0.03,
  brierDampenN90: 30,
  brierDampenDrift: 0.015,
});

/**
 * Resolve BTTS H2H prior + strength voor een sport.
 * @param {object} calib  Loaded calib.json contents
 * @param {string} sport  EdgePickr sport-key (football/basketball/etc)
 * @returns {{rate: number, k: number}}
 */
function getBttsPrior(calib, sport) {
  const cfg = calib?.bttsPriors?.[sport];
  if (!cfg) return { rate: DEFAULT_BTTS_PRIOR_RATE, k: DEFAULT_BTTS_PRIOR_K };
  const rate = Number.isFinite(cfg.rate) ? cfg.rate : DEFAULT_BTTS_PRIOR_RATE;
  const k    = Number.isFinite(cfg.k)    ? cfg.k    : DEFAULT_BTTS_PRIOR_K;
  return { rate, k };
}

/**
 * Resolve minimum estimated probability voor een markt-type.
 * @param {object} calib
 * @param {string} marketType  'ml', '1x2', 'btts', 'ou', 'ah', 'dnb', 'dc'
 * @returns {number}
 */
function getMinEp(calib, marketType) {
  const v = calib?.minEp?.[marketType];
  if (Number.isFinite(v) && v > 0 && v < 1) return v;
  return DEFAULT_MIN_EP;
}

/**
 * Resolve model-vs-market divergence threshold per sport.
 * @param {object} calib
 * @param {string} sport
 * @returns {number}  fraction (0.07 = 7pp)
 */
function getDivergenceThreshold(calib, sport) {
  const v = calib?.divergenceThresholds?.[sport];
  if (Number.isFinite(v) && v > 0 && v < 0.5) return v;
  return DEFAULT_DIVERGENCE;
}

/**
 * Resolve NHL OT home-win-share. Auto-calibrated uit settled hockey AOT-bets.
 * @param {object} calib
 * @returns {number}  fraction (0.52 = 52% home wins in OT)
 */
function getNhlOtHomeShare(calib) {
  const v = calib?.nhlOtHomeShare?.rate;
  if (Number.isFinite(v) && v >= 0.45 && v <= 0.60) return v;
  return DEFAULT_NHL_OT_HOME;
}

function getSignalThresholds(calib) {
  const cfg = calib?.signalThresholds || {};
  const out = { ...DEFAULT_SIGNAL_THRESHOLDS };
  for (const key of Object.keys(out)) {
    const v = cfg[key];
    if (Number.isFinite(v)) out[key] = v;
  }
  out.killMinN = Math.max(1, Math.round(out.killMinN));
  out.promoteMinN = Math.max(1, Math.round(out.promoteMinN));
  out.brierMuteN90 = Math.max(1, Math.round(out.brierMuteN90));
  out.brierDampenN90 = Math.max(1, Math.round(out.brierDampenN90));
  out.brierMuteDrift = Math.max(0, Math.min(0.20, out.brierMuteDrift));
  out.brierDampenDrift = Math.max(0, Math.min(out.brierMuteDrift, out.brierDampenDrift));
  return out;
}

/**
 * v14.0: dataConfidence-ramp voor h2h sample-size. Vervangt binary
 * `h2hN >= 5` met smooth confidence in [0, 1]. n=0 → 0 (geen data),
 * n=10 → 1 (volle confidence). Caller kan deze waarde gebruiken om
 * pick-EV te dempen i.p.v. hard-block.
 */
function h2hConfidence(h2hN) {
  if (!Number.isFinite(h2hN) || h2hN <= 0) return 0;
  return Math.min(1, h2hN / 10);
}

module.exports = {
  getBttsPrior,
  getMinEp,
  getDivergenceThreshold,
  getNhlOtHomeShare,
  getSignalThresholds,
  h2hConfidence,
  // Defaults exported voor tests + fallback in oude code-paden
  DEFAULT_BTTS_PRIOR_RATE,
  DEFAULT_BTTS_PRIOR_K,
  DEFAULT_MIN_EP,
  DEFAULT_NHL_OT_HOME,
  DEFAULT_DIVERGENCE,
  DEFAULT_SIGNAL_THRESHOLDS,
};
