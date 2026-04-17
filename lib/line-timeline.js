'use strict';

/**
 * EdgePickr Price-memory query layer (sectie 6 Bouwvolgorde fundament 2,
 * sectie 10.A doctrine). Leest `odds_snapshots` en bouwt per
 * (fixture, market_type, line, selection_key) een line-timeline op met:
 *   - open / first_seen / first_seen_on_preferred
 *   - scan_anchor / latest_pre_kickoff / close
 *   - afgeleiden: drift, steam, stale, preferred_gap, time_to_move,
 *     bookmaker_count, market_avg_open / market_avg_close
 *
 * Bewust opgesplitst van `lib/snapshots.js` (write-only): deze module is
 * read-only / derive-only en wordt door execution-quality + autotune
 * gevoed. Geen state, geen side-effects naast de supabase select.
 *
 * Pure helpers (`buildTimeline`, `groupByLine`, etc.) zijn testbaar zonder
 * supabase-mock. De async wrapper `getLineTimeline` doet alleen de query.
 */

// ── Pure helpers ────────────────────────────────────────────────────────────

function impliedProb(odds) {
  const o = parseFloat(odds);
  return Number.isFinite(o) && o > 1 ? 1 / o : null;
}

function ts(row) {
  if (!row || !row.captured_at) return 0;
  const t = Date.parse(row.captured_at);
  return Number.isFinite(t) ? t : 0;
}

function average(values) {
  const xs = values.filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// v10.10.20: sharp-reference bookies — industrie-standaard "true price"
// bronnen. Hard gescheiden van preferred/execution bookies (Codex-doctrine).
const SHARP_BOOKIES = new Set([
  'pinnacle', 'betfair', 'pinnacle sports', 'betfair exchange',
  'circa', 'circa sports', 'betcris',
]);

function isPreferredBookie(name, preferredSet) {
  if (!preferredSet || !preferredSet.size || !name) return false;
  return preferredSet.has(String(name).toLowerCase());
}

function isSharpBookie(name, sharpSet) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  const set = sharpSet && sharpSet.size ? sharpSet : SHARP_BOOKIES;
  return [...set].some(s => lower.includes(s));
}

/**
 * Groepeer rows naar buckets per (selection_key, line). NULL-line wordt
 * normalised naar 'null' string-key zodat moneyline + totals/spreads
 * dezelfde grouping kunnen volgen.
 */
function groupByLine(rows) {
  const buckets = new Map();
  for (const r of rows || []) {
    if (!r || !r.selection_key) continue;
    const lineKey = r.line != null && Number.isFinite(parseFloat(r.line))
      ? String(parseFloat(r.line))
      : 'null';
    const key = `${r.selection_key}|${lineKey}`;
    if (!buckets.has(key)) buckets.set(key, { selectionKey: r.selection_key, line: r.line != null ? parseFloat(r.line) : null, rows: [] });
    buckets.get(key).rows.push(r);
  }
  // Sorteer rows in elke bucket chronologisch
  for (const bucket of buckets.values()) {
    bucket.rows.sort((a, b) => ts(a) - ts(b));
  }
  return buckets;
}

/**
 * Aggregate één tijdpunt: marktgemiddelde implied prob + best price + best
 * preferred price (indien aanwezig).
 */
function snapshotAggregate(rowsAtT, preferredSet, sharpSet) {
  if (!rowsAtT || !rowsAtT.length) return null;
  const probs = rowsAtT.map(r => impliedProb(r.odds)).filter(p => p != null);
  const prices = rowsAtT.map(r => parseFloat(r.odds)).filter(p => Number.isFinite(p) && p > 1);
  const preferredPrices = rowsAtT
    .filter(r => isPreferredBookie(r.bookmaker, preferredSet))
    .map(r => parseFloat(r.odds))
    .filter(p => Number.isFinite(p) && p > 1);
  const sharpRows = rowsAtT.filter(r => isSharpBookie(r.bookmaker, sharpSet));
  const sharpPrices = sharpRows.map(r => parseFloat(r.odds)).filter(p => Number.isFinite(p) && p > 1);
  const bestSharp = sharpPrices.length
    ? sharpRows.reduce((best, r) => {
        const p = parseFloat(r.odds);
        return p > best.price ? { price: p, bookie: r.bookmaker } : best;
      }, { price: 0, bookie: '' })
    : null;
  return {
    capturedAt: rowsAtT[0].captured_at,
    marketAvgProb: average(probs),
    bestPrice: prices.length ? Math.max(...prices) : null,
    bestPreferredPrice: preferredPrices.length ? Math.max(...preferredPrices) : null,
    bestSharpPrice: bestSharp ? +bestSharp.price.toFixed(3) : null,
    bestSharpBookie: bestSharp ? bestSharp.bookie : null,
    bookmakerCount: new Set(rowsAtT.map(r => r.bookmaker)).size,
  };
}

/**
 * Cluster rows op exact identiek captured_at (één scan-cycle).
 */
function clusterByCapturedAt(rows) {
  const clusters = new Map();
  for (const r of rows) {
    if (!r.captured_at) continue;
    if (!clusters.has(r.captured_at)) clusters.set(r.captured_at, []);
    clusters.get(r.captured_at).push(r);
  }
  return [...clusters.entries()]
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([_, rs]) => rs);
}

/**
 * Vind de cluster dichtst bij targetMs. Returnt null bij geen clusters.
 */
function findNearest(clusters, targetMs) {
  if (!clusters || !clusters.length || !Number.isFinite(targetMs)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const cluster of clusters) {
    const t = Date.parse(cluster[0].captured_at);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - targetMs);
    if (delta < bestDelta) { best = cluster; bestDelta = delta; }
  }
  return best;
}

/**
 * Bouw timeline voor één (selection, line) bucket.
 *
 * @param {Array} rows - sorted ascending op captured_at, alle voor zelfde
 *                       (selection, line) bucket
 * @param {object} params
 *   - preferredSet: Set<string> lowercase preferred bookmaker names
 *   - kickoffMs: kickoff time ms (voor pre-kickoff / close window)
 *   - scanAnchorMs: scan-tijd ms (voor scan_anchor)
 *   - closeWindowMs: ms vóór kickoff dat als "close" telt (default 5 min)
 *   - preKickoffWindowMs: breedte van de pre-kickoff window direct vóór de
 *                        close-window (default 30 min). Dus bij
 *                        closeWindow=5m en preKickoffWindow=30m loopt de
 *                        pre-window van T-35m t/m <T-5m.
 *   - moveThreshold: minimum implied-prob delta om als "move" te tellen
 *                    (default 0.005 = 0.5pp)
 */
function buildTimeline(rows, params = {}) {
  const preferredSet = params.preferredSet instanceof Set
    ? params.preferredSet
    : new Set((params.preferredBookies || []).map(s => String(s).toLowerCase()));
  const sharpSet = params.sharpSet instanceof Set
    ? params.sharpSet
    : (params.sharpBookies ? new Set(params.sharpBookies.map(s => String(s).toLowerCase())) : SHARP_BOOKIES);
  const kickoffMs = Number.isFinite(params.kickoffMs) ? params.kickoffMs : null;
  const scanAnchorMs = Number.isFinite(params.scanAnchorMs) ? params.scanAnchorMs : null;
  const closeWindowMs = Number.isFinite(params.closeWindowMs) ? params.closeWindowMs : 5 * 60 * 1000;
  const preKickoffWindowMs = Number.isFinite(params.preKickoffWindowMs) ? params.preKickoffWindowMs : 30 * 60 * 1000;
  const moveThreshold = Number.isFinite(params.moveThreshold) ? params.moveThreshold : 0.005;

  const clusters = clusterByCapturedAt(rows);
  if (!clusters.length) {
    return {
      open: null, firstSeen: null, firstSeenOnPreferred: null,
      scanAnchor: null, latestPreKickoff: null, close: null,
      drift: null, preferredGap: null, stale: null,
      sharpGap: null, sharpPrice: null, sharpBookie: null,
      timeToMoveMs: null, bookmakerCountMax: 0, samples: 0,
    };
  }

  // Open = eerste cluster (chronologisch).
  const openCluster = clusters[0];
  const open = snapshotAggregate(openCluster, preferredSet, sharpSet);
  // first_seen = synoniem voor open op deze (selection, line) bucket.
  const firstSeen = open;

  // first_seen_on_preferred: eerste cluster waar tenminste één preferred bookie vóórkomt.
  let firstSeenOnPreferred = null;
  for (const cluster of clusters) {
    const hasPref = cluster.some(r => isPreferredBookie(r.bookmaker, preferredSet));
    if (hasPref) {
      firstSeenOnPreferred = snapshotAggregate(cluster, preferredSet, sharpSet);
      break;
    }
  }

  // scan_anchor: cluster dichtst bij scanAnchorMs (of null).
  const scanAnchorCluster = scanAnchorMs != null ? findNearest(clusters, scanAnchorMs) : null;
  const scanAnchor = scanAnchorCluster ? snapshotAggregate(scanAnchorCluster, preferredSet, sharpSet) : null;

  // Windows (heldere definities):
  //   close window       = [kickoff - closeWindowMs, kickoff]
  //   pre-kickoff window = [kickoff - closeWindowMs - preKickoffWindowMs,
  //                         kickoff - closeWindowMs)
  // Beide exclusief samen, zodat latestPreKickoff en close nooit dezelfde
  // cluster wijzen tenzij de operator ze expliciet overlappend configureert.
  let latestPreKickoff = null;
  let close = null;
  if (kickoffMs != null) {
    const closeStart = kickoffMs - closeWindowMs;
    const preStart = closeStart - preKickoffWindowMs;
    const inClose = (c) => {
      const t = Date.parse(c[0].captured_at);
      return Number.isFinite(t) && t >= closeStart && t <= kickoffMs;
    };
    const inPre = (c) => {
      const t = Date.parse(c[0].captured_at);
      return Number.isFinite(t) && t >= preStart && t < closeStart;
    };
    const closeClusters = clusters.filter(inClose);
    const preClusters = clusters.filter(inPre);
    close = closeClusters.length
      ? snapshotAggregate(closeClusters[closeClusters.length - 1], preferredSet, sharpSet)
      : null;
    latestPreKickoff = preClusters.length
      ? snapshotAggregate(preClusters[preClusters.length - 1], preferredSet, sharpSet)
      : null;
  }

  // Drift: implied-prob delta tussen open en close (positief = prob is gestegen
  // = prijs is gezakt = markt vond outcome waarschijnlijker).
  const driftRef = close || latestPreKickoff || (clusters.length > 1 ? snapshotAggregate(clusters[clusters.length - 1], preferredSet, sharpSet) : null);
  const drift = (open?.marketAvgProb != null && driftRef?.marketAvgProb != null)
    ? +(driftRef.marketAvgProb - open.marketAvgProb).toFixed(5)
    : null;

  // preferred_gap (in odds): best_market_price - best_preferred_price aan
  // close. Positief = preferred achterloopt op markt = stale-risk.
  const gapRef = close || latestPreKickoff;
  const preferredGap = (gapRef?.bestPrice != null && gapRef?.bestPreferredPrice != null)
    ? +(gapRef.bestPrice - gapRef.bestPreferredPrice).toFixed(4)
    : null;

  // stale: preferred achterloopt structureel (>= 0.05 odds) op marktbest aan
  // close. Boolean — niet doorvertalen naar Kelly hier; dat doet
  // applyExecutionGate in een latere slice.
  const stale = preferredGap != null && preferredGap >= 0.05;

  // time_to_move (ms): mediaan tijd tussen "significant moves" (implied-prob
  // delta >= moveThreshold). Returnt null bij <2 moves.
  const moves = [];
  let prevProb = open?.marketAvgProb;
  let prevT = openCluster.length ? Date.parse(openCluster[0].captured_at) : null;
  for (let i = 1; i < clusters.length; i++) {
    const agg = snapshotAggregate(clusters[i], preferredSet, sharpSet);
    const t = Date.parse(clusters[i][0].captured_at);
    if (agg?.marketAvgProb != null && prevProb != null && Number.isFinite(t) && Number.isFinite(prevT)) {
      const delta = Math.abs(agg.marketAvgProb - prevProb);
      if (delta >= moveThreshold) {
        moves.push(t - prevT);
        prevProb = agg.marketAvgProb;
        prevT = t;
      }
    }
  }
  const timeToMoveMs = moves.length >= 2
    ? Math.round(moves.sort((a, b) => a - b)[Math.floor(moves.length / 2)])
    : null;

  const bookmakerCountMax = clusters.reduce((max, c) => Math.max(max, new Set(c.map(r => r.bookmaker)).size), 0);

  // v10.10.20: sharp-reference gap. Verschil preferred vs sharp-bookie aan
  // close. Positief = sharp bookie biedt betere odds = preferred achterloopt
  // niet alleen op market-best maar specifiek op de scherpste referentie.
  const sharpRef = close || latestPreKickoff;
  const sharpGap = (sharpRef?.bestSharpPrice != null && sharpRef?.bestPreferredPrice != null)
    ? +(sharpRef.bestSharpPrice - sharpRef.bestPreferredPrice).toFixed(4)
    : null;
  const sharpPrice = sharpRef?.bestSharpPrice ?? null;
  const sharpBookie = sharpRef?.bestSharpBookie ?? null;

  return {
    open, firstSeen, firstSeenOnPreferred,
    scanAnchor, latestPreKickoff, close,
    drift, preferredGap, stale,
    sharpGap, sharpPrice, sharpBookie,
    timeToMoveMs, bookmakerCountMax, samples: clusters.length,
  };
}

/**
 * Async wrapper: query odds_snapshots + bouw timeline per (selection, line).
 * Returnt Map<bucketKey, timeline> waar bucketKey = `${selectionKey}|${line ?? 'null'}`.
 *
 * @param {object} supabase - supabase client
 * @param {object} params
 *   - fixtureId (required)
 *   - marketType (required)
 *   - line (optional filter)
 *   - selectionKey (optional filter)
 *   - preferredBookies (string[]) — voor preferred-gap berekening
 *   - kickoffTime (ISO of ms) — voor pre-kickoff/close window
 *   - scanAnchorTime (ISO of ms) — voor scan_anchor
 */
async function getLineTimeline(supabase, params = {}) {
  const { fixtureId, marketType } = params;
  if (!supabase || !fixtureId || !marketType) return new Map();

  let query = supabase.from('odds_snapshots')
    .select('captured_at, bookmaker, market_type, selection_key, line, odds')
    .eq('fixture_id', fixtureId)
    .eq('market_type', marketType)
    .order('captured_at', { ascending: true });
  if (params.line != null && Number.isFinite(parseFloat(params.line))) {
    query = query.eq('line', +parseFloat(params.line).toFixed(2));
  }
  if (params.selectionKey) query = query.eq('selection_key', params.selectionKey);

  let rows = [];
  try {
    const { data, error } = await query;
    if (error) return new Map();
    rows = data || [];
  } catch (e) {
    return new Map();
  }

  const toMs = (v) => {
    if (Number.isFinite(v)) return v;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    return null;
  };
  const buildParams = {
    preferredBookies: params.preferredBookies || [],
    kickoffMs: toMs(params.kickoffTime),
    scanAnchorMs: toMs(params.scanAnchorTime),
    closeWindowMs: params.closeWindowMs,
    preKickoffWindowMs: params.preKickoffWindowMs,
    moveThreshold: params.moveThreshold,
  };

  const buckets = groupByLine(rows);
  const out = new Map();
  for (const [key, bucket] of buckets) {
    out.set(key, {
      selectionKey: bucket.selectionKey,
      line: bucket.line,
      timeline: buildTimeline(bucket.rows, buildParams),
    });
  }
  return out;
}

/**
 * v10.12.2 (Phase A.1 · price-memory → execution-gate plumbing).
 *
 * Pure helper: converteer een `buildTimeline()` output naar de metrics-shape
 * die `applyExecutionGate()` (lib/execution-gate.js) verwacht. Leaves `null`
 * fields als de timeline geen datapunten heeft — applyExecutionGate behandelt
 * null velden als "geen signaal, geen demping" zodat backwards-compat staat.
 *
 * opts.twoWayMarket: boolean — bij true wordt de overround op 2-way basis
 * berekend (ML zonder gelijkspel). Anders 3-way (football 1X2). Default: false.
 */
function deriveExecutionMetrics(timeline, opts = {}) {
  const twoWayMarket = opts.twoWayMarket === true;
  if (!timeline || typeof timeline !== 'object') return null;

  const gapRef = timeline.close || timeline.latestPreKickoff || timeline.scanAnchor || timeline.firstSeen || null;
  const preferredGap = Number.isFinite(timeline.preferredGap) ? timeline.preferredGap : null;

  // preferredGapPct = (market-best - preferred) / preferred × 100.
  // Alleen betekenisvol als beide prijzen bekend.
  let preferredGapPct = null;
  if (gapRef && Number.isFinite(gapRef.bestPreferredPrice) && gapRef.bestPreferredPrice > 1 && Number.isFinite(gapRef.bestPrice) && gapRef.bestPrice > 1) {
    preferredGapPct = +((gapRef.bestPrice - gapRef.bestPreferredPrice) / gapRef.bestPreferredPrice * 100).toFixed(3);
  }

  // stalePct = absolute preferredGap als percentage van preferred-price.
  // Synoniem met preferredGapPct hier, maar doctrine-notatie hanteert beide
  // concepten los (stale = "preferred achterloopt structureel", gapPct =
  // "market-best ligt X% hoger").
  const stalePct = preferredGapPct;

  // overroundPct: 2-way = max(0, avg_implied * 2 - 1) × 100 → 6% bij normale
  // ML markt, blowout bij >10%. 3-way = avg_implied * 3 - 1.
  // Approximatie: marketAvgProb is gemiddelde over ALLE bookies → niet exact
  // de som-van-beste-prijzen overround, maar representatief genoeg voor
  // gate-threshold doeleinden. Een precieze overround vereist per-snapshot
  // selection-keys, wat deze module niet aggregeert.
  let overroundPct = null;
  if (gapRef && Number.isFinite(gapRef.marketAvgProb)) {
    const factor = twoWayMarket ? 2 : 3;
    overroundPct = +(Math.max(0, gapRef.marketAvgProb * factor - 1) * 100).toFixed(2);
  }

  const bookmakerCountMax = Number.isFinite(timeline.bookmakerCountMax) ? timeline.bookmakerCountMax : 0;

  // has_target_bookie: we weten dit pas zeker als firstSeenOnPreferred niet-null is.
  // Als preferredGap bekend is, heeft de preferred bookie het ooit gequoted
  // (gapRef.bestPreferredPrice > 0).
  const hasTargetBookie = !!(gapRef && Number.isFinite(gapRef.bestPreferredPrice) && gapRef.bestPreferredPrice > 1);

  return {
    preferredGap,
    preferredGapPct,
    stalePct,
    overroundPct,
    bookmakerCountMax,
    hasTargetBookie,
    sharpGap: Number.isFinite(timeline.sharpGap) ? timeline.sharpGap : null,
    drift: Number.isFinite(timeline.drift) ? timeline.drift : null,
    samples: timeline.samples || 0,
  };
}

/**
 * v10.12.2: bulk scan-timeline loader. Voorheen moest elke pick apart
 * `getLineTimeline()` aanroepen — één DB-query per pick, O(N) calls voor een
 * scan van N picks. Deze helper doet één bulk-query per scan en bouwt per
 * (fixture_id, market_type, selection_key, line) de timeline. Callers
 * kunnen daarna `lookupTimeline(map, {fixtureId, marketType, selectionKey, line})`
 * gebruiken voor O(1) lookups tijdens de gate-pass.
 *
 * @param {object} supabase
 * @param {object} params
 *   - fixtureIds: number[] (required)
 *   - marketTypes: string[] (optional filter; default: all)
 *   - preferredBookies: string[] (optional, voor preferred-gap)
 *   - kickoffByFixtureId: Map<number, ms> (optional, voor kickoff windows)
 *   - scanAnchorMs: ms (optional, voor scan_anchor)
 * @returns {Promise<Map<string, timeline>>} keyed door `${fixtureId}|${marketType}|${selectionKey}|${line ?? 'null'}`
 */
async function buildScanTimelineMap(supabase, params = {}) {
  const { fixtureIds, marketTypes, preferredBookies, kickoffByFixtureId, scanAnchorMs } = params;
  const out = new Map();
  if (!supabase || !Array.isArray(fixtureIds) || fixtureIds.length === 0) return out;

  let query = supabase.from('odds_snapshots')
    .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
    .in('fixture_id', fixtureIds)
    .order('captured_at', { ascending: true });
  if (Array.isArray(marketTypes) && marketTypes.length) {
    query = query.in('market_type', marketTypes);
  }

  let rows = [];
  try {
    const { data, error } = await query;
    if (error) return out;
    rows = data || [];
  } catch (_) { return out; }

  // Groepeer per (fixture_id, market_type)
  const byFixtureMarket = new Map();
  for (const r of rows) {
    if (!r || r.fixture_id == null || !r.market_type || !r.selection_key) continue;
    const key = `${r.fixture_id}|${r.market_type}`;
    if (!byFixtureMarket.has(key)) byFixtureMarket.set(key, []);
    byFixtureMarket.get(key).push(r);
  }

  for (const [fmKey, fmRows] of byFixtureMarket) {
    const [fixtureIdStr] = fmKey.split('|');
    const fixtureId = parseInt(fixtureIdStr, 10);
    const kickoffMs = kickoffByFixtureId instanceof Map ? kickoffByFixtureId.get(fixtureId) : null;
    const buckets = groupByLine(fmRows);
    for (const [bucketKey, bucket] of buckets) {
      const timeline = buildTimeline(bucket.rows, {
        preferredBookies: preferredBookies || [],
        kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
        scanAnchorMs: Number.isFinite(scanAnchorMs) ? scanAnchorMs : null,
      });
      out.set(`${fmKey}|${bucketKey}`, {
        fixtureId,
        marketType: fmRows[0].market_type,
        selectionKey: bucket.selectionKey,
        line: bucket.line,
        timeline,
      });
    }
  }

  return out;
}

/**
 * O(1) lookup in een `buildScanTimelineMap` resultaat.
 */
function lookupTimeline(timelineMap, { fixtureId, marketType, selectionKey, line }) {
  if (!(timelineMap instanceof Map)) return null;
  const lineKey = line != null && Number.isFinite(parseFloat(line))
    ? String(parseFloat(line))
    : 'null';
  const key = `${fixtureId}|${marketType}|${selectionKey}|${lineKey}`;
  const entry = timelineMap.get(key);
  return entry || null;
}

module.exports = {
  // Async (heeft supabase nodig)
  getLineTimeline,
  buildScanTimelineMap,
  // Pure (testbaar zonder mocks)
  buildTimeline,
  deriveExecutionMetrics,
  lookupTimeline,
  groupByLine,
  clusterByCapturedAt,
  snapshotAggregate,
  findNearest,
  // Sharp reference (v10.10.20)
  SHARP_BOOKIES,
  isSharpBookie,
};
