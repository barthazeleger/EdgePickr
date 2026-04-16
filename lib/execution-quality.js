'use strict';

function toMs(v) {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeBookmaker(name) {
  return (name || '').toString().trim().toLowerCase();
}

function sameLine(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 0.01;
}

function summarizePoint(rows, preferredBookiesLower = [], bookmaker = '') {
  const valid = (rows || []).filter(r => parseFloat(r.odds) > 1.0);
  if (!valid.length) return null;
  const bestOverall = valid.reduce((best, r) => parseFloat(r.odds) > parseFloat(best.odds) ? r : best, valid[0]);
  const preferredRows = preferredBookiesLower.length
    ? valid.filter(r => preferredBookiesLower.some(p => normalizeBookmaker(r.bookmaker).includes(p)))
    : [];
  const bestPreferred = preferredRows.length
    ? preferredRows.reduce((best, r) => parseFloat(r.odds) > parseFloat(best.odds) ? r : best, preferredRows[0])
    : null;
  const targetBook = bookmaker
    ? valid.find(r => normalizeBookmaker(r.bookmaker) === normalizeBookmaker(bookmaker))
      || valid.find(r => normalizeBookmaker(r.bookmaker).includes(normalizeBookmaker(bookmaker)))
    : null;
  const oddsValues = valid.map(r => parseFloat(r.odds)).filter(Number.isFinite).sort((a, b) => a - b);
  const minOdds = oddsValues[0];
  const maxOdds = oddsValues[oddsValues.length - 1];
  const marketWidthPct = maxOdds > 0 ? +(((maxOdds - minOdds) / maxOdds) * 100).toFixed(2) : null;
  return {
    captured_at: valid[0].captured_at,
    bookie_count: new Set(valid.map(r => normalizeBookmaker(r.bookmaker))).size,
    best_overall: { bookmaker: bestOverall.bookmaker, odds: +parseFloat(bestOverall.odds).toFixed(3) },
    best_preferred: bestPreferred ? { bookmaker: bestPreferred.bookmaker, odds: +parseFloat(bestPreferred.odds).toFixed(3) } : null,
    target_book: targetBook ? { bookmaker: targetBook.bookmaker, odds: +parseFloat(targetBook.odds).toFixed(3) } : null,
    market_width_pct: marketWidthPct,
  };
}

function classifyExecution({ stalePct, moveToLatestPct, bookieCount, marketWidthPct, targetPresent }) {
  if (!targetPresent) return 'no_target_bookie';
  if ((bookieCount || 0) < 2) return 'thin_market';
  if ((stalePct || 0) >= 4) return 'stale_price';
  if ((marketWidthPct || 0) >= 8) return 'wide_market';
  if ((moveToLatestPct || 0) >= 2) return 'beat_market';
  if ((stalePct || 0) <= 1.0) return 'playable';
  return 'thin_edge';
}

function summarizeExecutionQuality(rows, opts = {}) {
  const {
    marketType,
    selectionKey,
    line = null,
    bookmaker = '',
    anchorIso = null,
    preferredBookiesLower = [],
  } = opts;
  const filtered = (rows || []).filter(r =>
    r &&
    r.market_type === marketType &&
    r.selection_key === selectionKey &&
    sameLine(r.line, line) &&
    parseFloat(r.odds) > 1.0 &&
    r.captured_at
  );
  if (!filtered.length) {
    return {
      market_type: marketType,
      selection_key: selectionKey,
      line: line == null ? null : +parseFloat(line).toFixed(2),
      points: 0,
      status: 'no_history',
    };
  }

  const byTime = new Map();
  for (const row of filtered) {
    const key = new Date(row.captured_at).toISOString();
    if (!byTime.has(key)) byTime.set(key, []);
    byTime.get(key).push(row);
  }
  const points = Array.from(byTime.entries())
    .map(([, group]) => summarizePoint(group, preferredBookiesLower, bookmaker))
    .filter(Boolean)
    .sort((a, b) => toMs(a.captured_at) - toMs(b.captured_at));
  if (!points.length) return { market_type: marketType, selection_key: selectionKey, line, points: 0, status: 'no_history' };

  const anchorMs = anchorIso ? toMs(anchorIso) : null;
  const anchorPoint = anchorMs != null
    ? [...points].reverse().find(p => toMs(p.captured_at) <= anchorMs) || points[0]
    : points[points.length - 1];
  const openPoint = points[0];
  const latestPoint = points[points.length - 1];
  const targetOdds = anchorPoint.target_book?.odds || null;
  const bestAtAnchor = anchorPoint.best_overall?.odds || null;
  const latestBest = latestPoint.best_overall?.odds || null;
  const stalePct = targetOdds && bestAtAnchor ? +(((bestAtAnchor - targetOdds) / bestAtAnchor) * 100).toFixed(2) : null;
  const moveToLatestPct = targetOdds && latestBest ? +(((targetOdds - latestBest) / latestBest) * 100).toFixed(2) : null;
  const preferredGapPct = anchorPoint.best_preferred?.odds && targetOdds
    ? +(((anchorPoint.best_preferred.odds - targetOdds) / anchorPoint.best_preferred.odds) * 100).toFixed(2)
    : null;
  const status = classifyExecution({
    stalePct,
    moveToLatestPct,
    bookieCount: anchorPoint.bookie_count,
    marketWidthPct: anchorPoint.market_width_pct,
    targetPresent: !!anchorPoint.target_book,
  });

  return {
    market_type: marketType,
    selection_key: selectionKey,
    line: line == null ? null : +parseFloat(line).toFixed(2),
    points: points.length,
    status,
    open: openPoint,
    anchor: anchorPoint,
    latest: latestPoint,
    stale_pct: stalePct,
    preferred_gap_pct: preferredGapPct,
    move_to_latest_pct: moveToLatestPct,
  };
}

module.exports = {
  normalizeBookmaker,
  summarizeExecutionQuality,
};
