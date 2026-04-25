'use strict';

const { devigProportional, devigLogMargin } = require('./devig');

/**
 * v12.2.22 (R1 spike): vergelijk devig-algorithms op historische odds-data.
 *
 * Doel: bepalen of log-margin (Newton-Raphson) materieel andere fair-probs
 * produceert dan de huidige proportional devigger op echte bookie-data.
 * Audit-suggestie was: "Marginaal preciezer." Backtest of dat klopt.
 *
 * Strategie: groepeer odds_snapshots per (fixture × market_type × line),
 * neem latest snapshot per (bookmaker × selection), devig per algorithm,
 * vergelijk fair-prob spread.
 *
 * Pure helper. Caller levert raw snapshots; deze functie doet groeperen +
 * devig + diff-stats. Geen Supabase-calls.
 */

/**
 * @param {Array<object>} snapshots — odds_snapshots rows
 * @param {object} opts
 *   - minBookmakers: skip groepen met minder dan N bookmakers (default 3)
 *   - sharpOnly: alleen Pinnacle/Betfair (default false)
 * @returns {object} {
 *   groupsAnalyzed,
 *   meanAbsDiffPp, maxAbsDiffPp,
 *   diffDistribution: {<0.5pp, <1pp, <2pp, >=2pp},
 *   sampleDiffs: top-10 grootste diffs voor inspectie
 * }
 */
function compareDevigOnSnapshots(snapshots, opts = {}) {
  const minBookmakers = opts.minBookmakers || 3;
  const sharpSet = opts.sharpOnly ? new Set(['pinnacle', 'betfair', 'pinnacle sports', 'betfair exchange']) : null;

  const groupKey = r => `${r.fixture_id}|${r.market_type}|${r.line == null ? '' : r.line}`;
  const grouped = new Map();
  for (const r of snapshots || []) {
    if (sharpSet && !sharpSet.has(String(r.bookmaker || '').toLowerCase())) continue;
    if (!Number.isFinite(Number(r.odds)) || Number(r.odds) <= 1) continue;
    const k = groupKey(r);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r);
  }

  const allDiffs = [];
  let groupsAnalyzed = 0;
  for (const [, rows] of grouped) {
    // Latest per (bookmaker × selection_key)
    const latest = new Map();
    for (const r of rows) {
      const innerKey = `${String(r.bookmaker || '').toLowerCase()}|${r.selection_key}`;
      const prev = latest.get(innerKey);
      const ts = Date.parse(r.captured_at) || 0;
      if (!prev || ts > prev._ts) latest.set(innerKey, { ...r, _ts: ts });
    }

    // Per bookmaker: collect odds-vector over alle selections
    const byBookie = new Map();
    for (const [, r] of latest) {
      const b = String(r.bookmaker || '').toLowerCase();
      if (!byBookie.has(b)) byBookie.set(b, new Map());
      byBookie.get(b).set(r.selection_key, Number(r.odds));
    }
    if (byBookie.size < minBookmakers) continue;

    // Verzamel uniforme selection-set
    const allSels = new Set();
    for (const [, sels] of byBookie) for (const s of sels.keys()) allSels.add(s);
    const selArr = [...allSels];
    if (selArr.length < 2) continue;

    // Per bookie: odds-array in vaste volgorde van selArr; skip als incompleet
    const completeBookies = [];
    for (const [bookie, sels] of byBookie) {
      if (selArr.every(s => sels.has(s))) {
        completeBookies.push({ bookie, odds: selArr.map(s => sels.get(s)) });
      }
    }
    if (completeBookies.length < minBookmakers) continue;

    // Per complete bookie: devig met beide algoritmes, neem mean per selection
    const propProbs = selArr.map(() => []);
    const logProbs = selArr.map(() => []);
    for (const { odds } of completeBookies) {
      const p = devigProportional(odds);
      const l = devigLogMargin(odds);
      if (!p || !l) continue;
      for (let i = 0; i < selArr.length; i++) {
        propProbs[i].push(p[i]);
        logProbs[i].push(l[i]);
      }
    }
    const meanProp = propProbs.map(arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null);
    const meanLog = logProbs.map(arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null);

    let maxDiffInGroup = 0;
    for (let i = 0; i < selArr.length; i++) {
      if (meanProp[i] == null || meanLog[i] == null) continue;
      const diffPp = Math.abs(meanProp[i] - meanLog[i]) * 100;
      if (diffPp > maxDiffInGroup) maxDiffInGroup = diffPp;
      allDiffs.push({
        fixture_id: rows[0].fixture_id,
        market_type: rows[0].market_type,
        line: rows[0].line,
        selection: selArr[i],
        meanProp: +meanProp[i].toFixed(5),
        meanLog: +meanLog[i].toFixed(5),
        diffPp: +diffPp.toFixed(3),
      });
    }
    groupsAnalyzed++;
  }

  if (!allDiffs.length) return { groupsAnalyzed: 0, meanAbsDiffPp: null, maxAbsDiffPp: null, diffDistribution: null, sampleDiffs: [] };

  const sumAbs = allDiffs.reduce((a, d) => a + Math.abs(d.diffPp), 0);
  const meanAbsDiffPp = +(sumAbs / allDiffs.length).toFixed(4);
  const maxAbsDiffPp = +Math.max(...allDiffs.map(d => Math.abs(d.diffPp))).toFixed(4);
  const dist = { '<0.5pp': 0, '<1pp': 0, '<2pp': 0, '>=2pp': 0 };
  for (const d of allDiffs) {
    const a = Math.abs(d.diffPp);
    if (a < 0.5) dist['<0.5pp']++;
    else if (a < 1) dist['<1pp']++;
    else if (a < 2) dist['<2pp']++;
    else dist['>=2pp']++;
  }
  const top = [...allDiffs].sort((a, b) => Math.abs(b.diffPp) - Math.abs(a.diffPp)).slice(0, 10);
  return {
    groupsAnalyzed,
    pairs: allDiffs.length,
    meanAbsDiffPp,
    maxAbsDiffPp,
    diffDistribution: dist,
    sampleDiffs: top,
  };
}

module.exports = { compareDevigOnSnapshots };
