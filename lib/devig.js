'use strict';

/**
 * v12.2.11 (R1 spike): alternative devigging algorithms.
 *
 * Huidige pipeline gebruikt proportionele devigging (1/odds normalized
 * over som). Recent SOTA (Pinnacle research, log-margin literature)
 * suggereert dat **log-margin devigging** marginaal preciezer is voor
 * markten met asymmetrische margin-spread (bv. heavy favorite/underdog).
 *
 * Beide functies returnen een array van fair probabilities die optellen
 * naar 1.0. Geen pipeline-integratie in deze release — alleen pure
 * helpers voor A/B-vergelijking via walk-forward backtest later.
 *
 * Referenties:
 *   - "Designing Sports Betting Systems in R" (R-bloggers, Feb 2026)
 *   - Pinnacle "What is Closing Line Value?" docs
 *   - Datagolf "How sharp are bookmakers?"
 */

/**
 * Proportionele devigging — huidige default.
 *
 * fair_p_i = (1/odd_i) / Σ(1/odd_j)
 *
 * Voordeel: simpel, robuust, snel.
 * Nadeel: aanname dat bookmaker margin uniform over outcomes verdeeld is —
 * bij favorite-longshot bias is dit niet altijd waar.
 */
function devigProportional(odds) {
  if (!Array.isArray(odds) || odds.length < 2) return null;
  const ips = odds.map(o => {
    const v = Number(o);
    return Number.isFinite(v) && v > 1 ? 1 / v : null;
  });
  if (ips.some(v => v === null)) return null;
  const total = ips.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  return ips.map(v => v / total);
}

/**
 * Log-margin devigging — alternatief.
 *
 * Werkwijze: zoek `k` zodanig dat fair_p_i = ip_i^k optelt naar 1.0.
 * Dit verdeelt de margin "log-evenredig", wat bewezen scherper is voor
 * heavy favorite/underdog markten.
 *
 * Numerieke methode: Newton-Raphson op f(k) = Σ ip_i^k - 1 = 0,
 * met startpunt k=1 en convergeert in <10 iteraties.
 *
 * @param {number[]} odds — decimal odds, ≥ 2 outcomes
 * @returns {number[] | null} fair probabilities, sum = 1
 */
function devigLogMargin(odds) {
  if (!Array.isArray(odds) || odds.length < 2) return null;
  const ips = odds.map(o => {
    const v = Number(o);
    return Number.isFinite(v) && v > 1 ? 1 / v : null;
  });
  if (ips.some(v => v === null || v <= 0)) return null;
  const total = ips.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;

  // Newton-Raphson: f(k) = Σ ip^k - 1, f'(k) = Σ ip^k * ln(ip)
  let k = 1;
  for (let iter = 0; iter < 30; iter++) {
    let f = -1;
    let fPrime = 0;
    for (const ip of ips) {
      const ipPowK = Math.pow(ip, k);
      f += ipPowK;
      fPrime += ipPowK * Math.log(ip);
    }
    if (Math.abs(f) < 1e-9) break;
    if (Math.abs(fPrime) < 1e-12) break; // protect against div by 0
    const nextK = k - f / fPrime;
    if (!Number.isFinite(nextK)) break;
    if (Math.abs(nextK - k) < 1e-10) { k = nextK; break; }
    k = nextK;
  }
  if (!Number.isFinite(k) || k <= 0) return null;
  const fair = ips.map(ip => Math.pow(ip, k));
  // Final renormalize — voor het geval Newton-Raphson niet exact convergeert
  const fairTotal = fair.reduce((s, v) => s + v, 0);
  if (!fairTotal) return null;
  return fair.map(v => v / fairTotal);
}

/**
 * Vergelijk log-margin vs proportional voor analyse-doeleinden.
 * Returnt {prop, logm, diff} arrays — `diff` is per-outcome verschil.
 */
function devigCompare(odds) {
  const prop = devigProportional(odds);
  const logm = devigLogMargin(odds);
  if (!prop || !logm) return null;
  return {
    proportional: prop,
    logMargin: logm,
    diff: prop.map((p, i) => +(logm[i] - p).toFixed(5)),
  };
}

module.exports = { devigProportional, devigLogMargin, devigCompare };
