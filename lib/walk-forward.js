'use strict';

/**
 * EdgePickr · Walk-forward validator (Phase B.4 · doctrine §14.R2.A).
 *
 * Sports data is tijds-gebonden: een random split lekt toekomst-info in
 * trainingsdata en overschat edge. Elke backtest-claim hoort op een
 * walk-forward split te draaien: train op t < T, test op t >= T.
 *
 * Module exports:
 *   - walkForward(records, { dateField, trainDays, testDays, strideDays, minTrainN })
 *       Pure iterator. Returnt array van { trainStart, trainEnd, testStart, testEnd, train, test }
 *       tuples. Timeline is ascending; geen lookahead.
 *   - computeBrier(records, { probField, actualField })
 *   - computeLogLoss(records, { probField, actualField })
 *   - computeClvAvg(records, { clvField })
 *   - walkForwardBrier(records, splitOpts, metricOpts)
 *       Convenience: per-split Brier op een modelled probability-feld.
 *
 * Al deze helpers zijn pure functies — geen supabase, geen side effects.
 * Geschikt voor CLI backtest scripts én live admin-endpoint preview.
 *
 * Design choices:
 *   - dateField is configureerbaar (default 'kickoff_at', val-back 'datum',
 *     verder 'created_at'). We sorten chronologisch, records zonder geldige
 *     datum worden overgeslagen.
 *   - Windows in dagen, niet ms — domain-natuurlijk.
 *   - `minTrainN` skipt splits waar training-set te klein is voor betekenisvolle
 *     fit (default 50). Doctrine: "signaal zonder sample size is noise."
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function parseRecordDate(record, dateField) {
  if (!record) return null;
  const raw = record[dateField] ?? record.kickoff_at ?? record.kickoff_time ?? record.datum ?? record.created_at;
  if (raw == null) return null;
  // Support "dd-mm-yyyy" (bets.datum), ISO, epoch ms
  if (Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const dmMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmMatch) {
      const ms = Date.parse(`${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}T12:00:00Z`);
      return Number.isFinite(ms) ? ms : null;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * walkForward
 * @param {Array} records - array of objects with a date field
 * @param {object} opts
 *   - dateField: string, key to parse as timestamp (default 'kickoff_at')
 *   - trainDays: training window in days (default 180)
 *   - testDays:  test window size per step (default 30)
 *   - strideDays: step size between consecutive test windows (default = testDays)
 *   - minTrainN: minimum training-set size for a split to be emitted (default 50)
 *   - minTestN:  minimum test-set size (default 5)
 *   - anchorMs:  optional explicit start anchor; default = min(date) in records
 * @returns {Array<{trainStart, trainEnd, testStart, testEnd, train, test}>}
 *   Alle timestamps zijn ms UTC. train/test zijn array van input records
 *   (reference equality — geen copy).
 */
function walkForward(records, opts = {}) {
  const dateField = opts.dateField || 'kickoff_at';
  const trainDays = Number.isFinite(opts.trainDays) ? opts.trainDays : 180;
  const testDays = Number.isFinite(opts.testDays) ? opts.testDays : 30;
  const strideDays = Number.isFinite(opts.strideDays) ? opts.strideDays : testDays;
  const minTrainN = Number.isFinite(opts.minTrainN) ? opts.minTrainN : 50;
  const minTestN = Number.isFinite(opts.minTestN) ? opts.minTestN : 5;

  if (!Array.isArray(records) || records.length === 0) return [];

  // Annotate + sort ascending by date, drop undated.
  const dated = records
    .map(r => ({ _t: parseRecordDate(r, dateField), r }))
    .filter(x => Number.isFinite(x._t))
    .sort((a, b) => a._t - b._t);
  if (dated.length === 0) return [];

  const firstTs = dated[0]._t;
  const lastTs  = dated[dated.length - 1]._t;
  const anchorMs = Number.isFinite(opts.anchorMs) ? opts.anchorMs : firstTs;

  const splits = [];
  // Eerste test-start is anchor + trainDays. Schuif steeds strideDays vooruit
  // tot test-window voorbij lastTs is.
  let testStart = anchorMs + trainDays * DAY_MS;
  while (testStart <= lastTs) {
    const testEnd = testStart + testDays * DAY_MS;
    const trainStart = testStart - trainDays * DAY_MS;
    const trainEnd = testStart;
    const train = dated.filter(x => x._t >= trainStart && x._t < trainEnd).map(x => x.r);
    const test  = dated.filter(x => x._t >= testStart && x._t < testEnd).map(x => x.r);
    if (train.length >= minTrainN && test.length >= minTestN) {
      splits.push({ trainStart, trainEnd, testStart, testEnd, train, test });
    }
    testStart += strideDays * DAY_MS;
  }
  return splits;
}

/**
 * Brier score: mean((p - y)^2) waar p = voorspelde probability [0,1] en
 * y = outcome {0,1}. Lager = beter. Perfect = 0. Random op 50/50 = 0.25.
 */
function computeBrier(records, opts = {}) {
  const probField = opts.probField || 'predicted_prob';
  const actualField = opts.actualField || 'outcome_binary';
  let sum = 0, n = 0;
  for (const r of records || []) {
    const pRaw = r?.[probField];
    const yRaw = r?.[actualField];
    if (pRaw == null || yRaw == null) continue;
    const p = Number(pRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
    if (p < 0 || p > 1) continue;
    if (y !== 0 && y !== 1) continue;
    sum += (p - y) ** 2;
    n++;
  }
  return n > 0 ? { score: +(sum / n).toFixed(5), n } : { score: null, n: 0 };
}

/**
 * Log-loss: mean(-(y*log(p) + (1-y)*log(1-p))). Lager = beter. Clamp op
 * [epsilon, 1-epsilon] om -Infinity te voorkomen.
 */
function computeLogLoss(records, opts = {}) {
  const probField = opts.probField || 'predicted_prob';
  const actualField = opts.actualField || 'outcome_binary';
  const eps = 1e-9;
  let sum = 0, n = 0;
  for (const r of records || []) {
    const pRaw = r?.[probField];
    const yRaw = r?.[actualField];
    if (pRaw == null || yRaw == null) continue;
    const p0 = Number(pRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(p0) || !Number.isFinite(y)) continue;
    if (y !== 0 && y !== 1) continue;
    const p = Math.min(1 - eps, Math.max(eps, p0));
    sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    n++;
  }
  return n > 0 ? { score: +(sum / n).toFixed(5), n } : { score: null, n: 0 };
}

/**
 * Gemiddelde CLV over records (bets). Returnt null als geen records CLV hebben.
 */
function computeClvAvg(records, opts = {}) {
  const clvField = opts.clvField || 'clv_pct';
  let sum = 0, n = 0;
  for (const r of records || []) {
    const c = Number(r?.[clvField]);
    if (!Number.isFinite(c)) continue;
    sum += c; n++;
  }
  return n > 0 ? { avg: +(sum / n).toFixed(3), n } : { avg: null, n: 0 };
}

/**
 * Convenience wrapper: loop walk-forward splits en rapporteer Brier per split.
 * Returnt summary: splits-array + overall weighted-avg Brier.
 */
function walkForwardBrier(records, splitOpts = {}, metricOpts = {}) {
  const splits = walkForward(records, splitOpts);
  const perSplit = splits.map(s => {
    const b = computeBrier(s.test, metricOpts);
    return {
      testStart: s.testStart, testEnd: s.testEnd,
      trainN: s.train.length, testN: s.test.length,
      brier: b.score, scoredN: b.n,
    };
  });
  // Weighted avg over scored samples
  let sum = 0, n = 0;
  for (const r of perSplit) {
    if (r.brier != null && r.scoredN > 0) { sum += r.brier * r.scoredN; n += r.scoredN; }
  }
  return {
    splitCount: splits.length,
    totalScoredN: n,
    weightedAvgBrier: n > 0 ? +(sum / n).toFixed(5) : null,
    splits: perSplit,
  };
}

module.exports = {
  walkForward,
  computeBrier,
  computeLogLoss,
  computeClvAvg,
  walkForwardBrier,
  parseRecordDate,
};
