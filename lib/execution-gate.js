'use strict';

/**
 * EdgePickr Execution Gate (sectie 6 Bouwvolgorde fundament 3,
 * sectie 10.A doctrine).
 *
 * Pure stake-multiplier op basis van `executionMetrics`. Gating hangt op
 * ruwe runtime-cijfers, niet op classifier-labels — zodat label-hertuning
 * het stake-regime niet stilletjes kantelt. Output is auditable: per
 * multiplier de bron en de drempel die hem triggerde.
 *
 * Geen state, geen side-effects. Aanroeper is verantwoordelijk voor het
 * vergaren van metrics uit `summarizeExecutionQuality(...)`,
 * `getLineTimeline(...)` en `getPreferredBookies(...)`. Helper
 * `buildExecutionMetrics(...)` consolideert die losse outputs in de
 * canonieke shape hieronder.
 *
 * ── Canonieke executionMetrics shape ──────────────────────────────────────
 *   targetPresent:      boolean    preferred bookie beschikbaar op anchor
 *                                  + close
 *   preferredGap:       number     odds-eenheid: marketBest - preferredBest
 *                                  aan close (positief = preferred
 *                                  achterloopt)
 *   preferredGapPct:    number     relatief: preferredGap / preferredBest
 *                                  (0.035 = 3.5%)
 *   bookmakerCountMax:  number     # unieke bookmakers in line-timeline window
 *   overroundPct:       number     markt-vig in fractie (0.06 = 6%)
 *   marketShape:        'two-way' | 'three-way'   voor sport-specifieke
 *                                                  overround thresholds
 *   drift:              number     optioneel — alleen explainability,
 *                                  beïnvloedt gate niet
 *   timeToMoveMs:       number     optioneel — alleen explainability
 *   status:             string     optioneel — classifier-label voor UI;
 *                                  beïnvloedt gate niet
 */

const DEFAULT_THRESHOLDS = {
  // Stale absolute (odds-eenheid)
  staleAbsHigh:         0.10,
  staleAbsMid:          0.05,
  // Preferred gap relatief (pct van preferred price)
  gapPctHigh:           0.035,
  gapPctMid:            0.020,
  // Markt overround per market shape
  overroundTwoWayMax:   0.08,
  overroundThreeWayMax: 0.12,
  // Bookmaker count
  bookmakerCountMin:    3,
  // Multipliers
  multStaleAbsHigh:     0.5,
  multStaleAbsMid:      0.7,
  multGapPctHigh:       0.6,
  multGapPctMid:        0.8,
  multOverround:        0.85,
  multThinMarket:       0.8,
};

const isNum = (v) => Number.isFinite(v);

/**
 * Hoofdfunctie. Returnt audit-bare structuur. `hk` resultaat is nooit > inkomend hk.
 *
 * @param {number} hk - inkomende half-Kelly fractie
 * @param {object} metrics - executionMetrics shape (zie module-doc)
 * @param {object} [thresholds] - overrides voor DEFAULT_THRESHOLDS
 * @returns {{ hk:number, skip:boolean, reasons:string[], multipliers:object, combinedMultiplier:number }}
 */
function applyExecutionGate(hk, metrics = {}, thresholds = {}) {
  const T = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const incoming = isNum(hk) && hk > 0 ? hk : 0;
  if (!incoming) {
    return { hk: 0, skip: false, reasons: ['hk_invalid_or_zero'], multipliers: {}, combinedMultiplier: 0 };
  }

  // Beschikbaarheid eerst: hard skip wint van alle multipliers.
  if (metrics.targetPresent === false) {
    return { hk: 0, skip: true, reasons: ['no_target_bookie'], multipliers: {}, combinedMultiplier: 0 };
  }

  const reasons = [];
  const mults = {};

  // Stale absolute (odds gap)
  if (isNum(metrics.preferredGap)) {
    if (metrics.preferredGap >= T.staleAbsHigh) {
      mults.staleAbs = T.multStaleAbsHigh;
      reasons.push(`stale_abs_high (gap=${metrics.preferredGap.toFixed(3)} >= ${T.staleAbsHigh})`);
    } else if (metrics.preferredGap >= T.staleAbsMid) {
      mults.staleAbs = T.multStaleAbsMid;
      reasons.push(`stale_abs_mid (gap=${metrics.preferredGap.toFixed(3)} >= ${T.staleAbsMid})`);
    }
  }

  // Preferred gap relatief (pct)
  if (isNum(metrics.preferredGapPct)) {
    if (metrics.preferredGapPct >= T.gapPctHigh) {
      mults.gapPct = T.multGapPctHigh;
      reasons.push(`gap_pct_high (${(metrics.preferredGapPct * 100).toFixed(2)}% >= ${(T.gapPctHigh * 100).toFixed(1)}%)`);
    } else if (metrics.preferredGapPct >= T.gapPctMid) {
      mults.gapPct = T.multGapPctMid;
      reasons.push(`gap_pct_mid (${(metrics.preferredGapPct * 100).toFixed(2)}% >= ${(T.gapPctMid * 100).toFixed(1)}%)`);
    }
  }

  // Markt-kwaliteit secundair
  if (isNum(metrics.overroundPct)) {
    const isThreeWay = metrics.marketShape === 'three-way';
    const max = isThreeWay ? T.overroundThreeWayMax : T.overroundTwoWayMax;
    if (metrics.overroundPct > max) {
      mults.overround = T.multOverround;
      reasons.push(`overround_high (${(metrics.overroundPct * 100).toFixed(2)}% > ${(max * 100).toFixed(1)}%, ${isThreeWay ? '3-way' : '2-way'})`);
    }
  }

  // Bookmaker count
  if (isNum(metrics.bookmakerCountMax) && metrics.bookmakerCountMax < T.bookmakerCountMin) {
    mults.thinMarket = T.multThinMarket;
    reasons.push(`thin_market (n=${metrics.bookmakerCountMax} < ${T.bookmakerCountMin})`);
  }

  const combined = Object.values(mults).reduce((acc, v) => acc * v, 1);
  return {
    hk: +(incoming * combined).toFixed(6),
    skip: false,
    reasons,
    multipliers: mults,
    combinedMultiplier: +combined.toFixed(4),
  };
}

/**
 * Helper: bouw `executionMetrics` uit beschikbare runtime-bronnen.
 * Consolideert losse outputs van `summarizeExecutionQuality(...)` en
 * `getLineTimeline(...)` (één bucket entry uit de Map) in de canonieke
 * shape die `applyExecutionGate` consumeert.
 *
 * @param {object} args
 *   - executionQuality: object uit summarizeExecutionQuality (mag null zijn)
 *   - lineTimeline: timeline-object uit getLineTimeline (één bucket-entry,
 *     dus `bucket.timeline`, niet de hele Map; mag null zijn)
 *   - marketShape: 'two-way' | 'three-way' (default 'two-way')
 */
function buildExecutionMetrics({ executionQuality, lineTimeline, marketShape = 'two-way' } = {}) {
  const eq = executionQuality || {};
  const lt = lineTimeline || {};
  const close = lt.close || lt.latestPreKickoff || null;

  const preferredGap = isNum(lt.preferredGap) ? lt.preferredGap : null;
  const preferredPrice = close && isNum(close.bestPreferredPrice) ? close.bestPreferredPrice : null;
  const preferredGapPct = (preferredGap != null && preferredPrice != null && preferredPrice > 0)
    ? +(preferredGap / preferredPrice).toFixed(5)
    : null;

  // targetPresent: true als preferred prijs zichtbaar in close óf executionQuality
  // expliciet bevestigt. Default: onbekend → null (niet false), zodat de gate
  // niet per ongeluk hard skipt op ontbrekende telemetrie.
  let targetPresent = null;
  if (preferredPrice != null && preferredPrice > 1) targetPresent = true;
  else if (eq.targetPresent === true) targetPresent = true;
  else if (eq.targetPresent === false) targetPresent = false;

  return {
    targetPresent,
    preferredGap,
    preferredGapPct,
    bookmakerCountMax: isNum(lt.bookmakerCountMax)
      ? lt.bookmakerCountMax
      : (isNum(eq.bookmakerCount) ? eq.bookmakerCount : null),
    overroundPct: isNum(eq.overround)
      ? eq.overround
      : (isNum(eq.overroundPct) ? eq.overroundPct : null),
    marketShape,
    drift: isNum(lt.drift) ? lt.drift : null,
    timeToMoveMs: isNum(lt.timeToMoveMs) ? lt.timeToMoveMs : null,
    status: eq.status || null,
  };
}

module.exports = {
  applyExecutionGate,
  buildExecutionMetrics,
  DEFAULT_THRESHOLDS,
};
