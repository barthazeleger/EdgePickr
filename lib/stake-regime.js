'use strict';

/**
 * EdgePickr · Unified stake-regime engine (Phase C.10 · doctrine §6 Fase 4).
 *
 * Voorheen waren er 3 onafhankelijke lagen die stake beïnvloedden:
 *   1. `getKellyFraction()` — global Kelly fraction (0.5 default, auto-stepup
 *      via `evaluateKellyAutoStepup` naar 0.75 cap bij bewezen CLV+ROI)
 *   2. `getDrawdownMultiplier()` — heuristische multiplier op kelly (×0.5
 *      bij >20% drawdown, ×0.7 bij <30% win rate, etc.)
 *   3. Unit-size `UNIT_EUR` per user — manual change only
 *
 * Deze verspreiding maakte regime-shifts traag. Het drawdown-pad kon kelly
 * halveren maar de unit onveranderd laten. Step-up kon kelly verhogen zonder
 * de drawdown-conditie te consulteren.
 *
 * Phase C.10: één functie die álle inputs bekijkt en één regime-besluit neemt:
 *   input:  {totalSettled, longTermClvPct, longTermRoi, recentClvPct,
 *            drawdownPct, consecutiveLosses, bankrollPeak, currentBankroll}
 *   output: {regime, kellyFraction, unitMultiplier, reasons[]}
 *
 * Regimes (doctrine §6 Fase 4: duidelijk onderscheid tussen exploratory
 * en proven-edge):
 *   - `drawdown_hard`  — drawdown ≥ 30% sinds peak → kelly 0.25, unit ×0.5
 *   - `drawdown_soft`  — drawdown ≥ 20% → kelly 0.40, unit ×1.0
 *   - `consecutive_l`  — ≥ 7 consecutive losses → kelly 0.35, unit ×0.75
 *   - `regime_shift`   — recent CLV divergeert materieel van long-term → kelly 0.40, unit ×1.0
 *   - `exploratory`    — totalSettled < 50 → kelly 0.35, unit ×1.0 (conservatief start)
 *   - `scale_up`       — 200+ settled, CLV ≥ 2%, ROI ≥ 5% → kelly 0.65, unit ×1.0
 *   - `standard`       — 100+ settled, CLV > 0% → kelly 0.50, unit ×1.0
 *   - fallback `exploratory`
 *
 * Unit-multiplier werkt multiplicatief bovenop operator's ingestelde
 * `unitEur`. ×1.0 = geen verandering, ×0.5 = halveren tijdens harde
 * drawdown (behoud dry powder voor recovery).
 *
 * **Belangrijk**: deze engine neemt géén beslissing rond *veranderen* van de
 * operator's configured `unitEur` — die blijft manual. De `unitMultiplier` is
 * een runtime-transient vermenigvuldiger op elke pick, niet een persistente
 * operator-setting. Zo vermijden we de "step-down verandert config, step-up
 * onthoudt config" valkuil.
 *
 * Priority order (highest gate wins):
 *   drawdown_hard > drawdown_soft > consecutive_l > regime_shift >
 *   (exploratory | scale_up | standard)
 */

/**
 * @param {object} input
 *   - totalSettled:      total W+L bets (lifetime)
 *   - longTermClvPct:    rolling 200-bet avg CLV % (null if not enough data)
 *   - longTermRoi:       rolling 200-bet ROI fraction (0.05 = 5%)
 *   - recentClvPct:      rolling 30-bet avg CLV % (null if not enough data)
 *   - drawdownPct:       (peak - current) / peak, fraction (0.20 = 20%)
 *   - consecutiveLosses: consecutive L streak count
 *   - bankrollPeak:      lifetime peak bankroll value
 *   - currentBankroll:   current bankroll value
 * @returns {object} {regime, kellyFraction, unitMultiplier, reasons[]}
 */
function evaluateStakeRegime(input = {}) {
  const reasons = [];
  const {
    totalSettled = 0,
    longTermClvPct = null,
    longTermRoi = null,
    recentClvPct = null,
    drawdownPct = 0,
    consecutiveLosses = 0,
    bankrollPeak = 0,
    currentBankroll = 0,
  } = input;

  const addReason = (regime, detail) => reasons.push(`${regime}: ${detail}`);

  // Hard drawdown: catastrophic loss territory. Minimum kelly + unit-halving.
  if (Number.isFinite(drawdownPct) && drawdownPct >= 0.30) {
    addReason('drawdown_hard', `drawdown ${(drawdownPct * 100).toFixed(1)}% sinds peak €${bankrollPeak} (nu €${currentBankroll})`);
    return { regime: 'drawdown_hard', kellyFraction: 0.25, unitMultiplier: 0.5, reasons };
  }

  // Soft drawdown: stop the bleeding, keep stakes flat but reduce Kelly.
  if (Number.isFinite(drawdownPct) && drawdownPct >= 0.20) {
    addReason('drawdown_soft', `drawdown ${(drawdownPct * 100).toFixed(1)}% sinds peak`);
    return { regime: 'drawdown_soft', kellyFraction: 0.40, unitMultiplier: 1.0, reasons };
  }

  // Consecutive losses: even without aggregate drawdown, L-streaks signal
  // variance regime (cold deck). Soft-dempen.
  if (consecutiveLosses >= 7) {
    addReason('consecutive_l', `${consecutiveLosses} consecutive L in a row`);
    return { regime: 'consecutive_l', kellyFraction: 0.35, unitMultiplier: 0.75, reasons };
  }

  // Regime-shift: if recent short-term CLV is materially worse than long-term,
  // something has changed (market sharpened, soft-books closed, signal decay).
  // Trigger: recent ≤ -1% AND longTerm ≥ +1% AND |delta| ≥ 2pp.
  if (
    Number.isFinite(recentClvPct) && Number.isFinite(longTermClvPct)
    && longTermClvPct >= 1.0 && recentClvPct <= -1.0
    && (longTermClvPct - recentClvPct) >= 2.0
  ) {
    addReason(
      'regime_shift',
      `long-term CLV +${longTermClvPct.toFixed(2)}% vs recent ${recentClvPct.toFixed(2)}% — edge regime shift`
    );
    return { regime: 'regime_shift', kellyFraction: 0.40, unitMultiplier: 1.0, reasons };
  }

  // Exploratory phase: too little data for any confident regime call.
  if (totalSettled < 50) {
    addReason('exploratory', `${totalSettled} settled bets < 50 threshold`);
    return { regime: 'exploratory', kellyFraction: 0.35, unitMultiplier: 1.0, reasons };
  }

  // Proven edge: step up — requires ALL positive signals.
  if (
    totalSettled >= 200
    && Number.isFinite(longTermClvPct) && longTermClvPct >= 2.0
    && Number.isFinite(longTermRoi) && longTermRoi >= 0.05
  ) {
    addReason(
      'scale_up',
      `${totalSettled} settled · CLV +${longTermClvPct.toFixed(2)}% · ROI ${(longTermRoi * 100).toFixed(1)}%`
    );
    return { regime: 'scale_up', kellyFraction: 0.65, unitMultiplier: 1.0, reasons };
  }

  // Standard operating: 100+ settled, CLV non-negative.
  if (totalSettled >= 100 && Number.isFinite(longTermClvPct) && longTermClvPct > 0) {
    addReason(
      'standard',
      `${totalSettled} settled · CLV +${longTermClvPct.toFixed(2)}%`
    );
    return { regime: 'standard', kellyFraction: 0.50, unitMultiplier: 1.0, reasons };
  }

  // Fallback: default conservative exploratory.
  addReason('exploratory', `geen duidelijk bewijs voor step-up (settled ${totalSettled}, CLV ${longTermClvPct ?? 'n/a'})`);
  return { regime: 'exploratory', kellyFraction: 0.35, unitMultiplier: 1.0, reasons };
}

module.exports = { evaluateStakeRegime };
