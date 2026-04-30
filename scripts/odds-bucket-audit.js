#!/usr/bin/env node
'use strict';

/**
 * v15.4 · Retrospectieve per-odds-bucket audit (PLAN §5.1, Codex finding #2).
 *
 * Output per bucket {low ≤2.0, mid 2.0–3.0, high >3.0} over rolling 30/90/365d:
 *   { n, roi_pct, avg_clv_pct, positive_clv_rate }
 *
 * Bron-tabel: `bets`. Voor vóór-v15.4 history zonder `odds_bucket` kolom valt
 * het script terug op een runtime-derivatie via `lib/picks::oddsBucket(odds)`,
 * zodat de audit ook over historische bets werkt zonder backfill.
 *
 * Gebruik:
 *   node scripts/odds-bucket-audit.js              # rolling 30/90/365d
 *   node scripts/odds-bucket-audit.js --json       # JSON output (voor diff/ci)
 *   node scripts/odds-bucket-audit.js --window=90  # alleen 90d
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { oddsBucket } = require('../lib/picks');

// Laad .env zoals scripts/migrate.js (idempotent als al gezet).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL en SUPABASE_KEY env vars vereist.');
  process.exit(1);
}

const DEFAULT_WINDOWS_DAYS = [30, 90, 365];

function parseArgs(argv) {
  const args = { json: false, windows: null };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--window=')) {
      const v = parseInt(a.slice('--window='.length), 10);
      if (Number.isFinite(v) && v > 0) args.windows = [v];
    }
  }
  if (!args.windows) args.windows = DEFAULT_WINDOWS_DAYS.slice();
  return args;
}

function parseDutchDate(dStr) {
  if (typeof dStr !== 'string') return null;
  const m = dStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return Date.parse(`${m[3]}-${m[2]}-${m[1]}T12:00:00Z`);
}

function bucketOf(row) {
  const stored = String(row?.odds_bucket || '').trim().toLowerCase();
  if (stored === 'low' || stored === 'mid' || stored === 'high') return stored;
  const derived = oddsBucket(Number(row?.odds));
  return derived || null;
}

function summarise(rows, windowDays) {
  const cutoffMs = Date.now() - windowDays * 86400000;
  const buckets = {
    low:  { n: 0, settled: 0, profit: 0, staked: 0, clvN: 0, clvSum: 0, clvPos: 0 },
    mid:  { n: 0, settled: 0, profit: 0, staked: 0, clvN: 0, clvSum: 0, clvPos: 0 },
    high: { n: 0, settled: 0, profit: 0, staked: 0, clvN: 0, clvSum: 0, clvPos: 0 },
  };
  for (const row of rows) {
    const ms = parseDutchDate(row?.datum);
    if (!Number.isFinite(ms) || ms < cutoffMs) continue;
    const b = bucketOf(row);
    if (!b || !buckets[b]) continue;
    buckets[b].n++;
    const settledFlag = row?.uitkomst === 'W' || row?.uitkomst === 'L';
    if (settledFlag) {
      buckets[b].settled++;
      const inzet = Number(row?.inzet);
      if (Number.isFinite(inzet) && inzet > 0) {
        buckets[b].staked += inzet;
        buckets[b].profit += Number(row?.wl) || 0;
      }
    }
    const clv = Number(row?.clv_pct);
    if (Number.isFinite(clv)) {
      buckets[b].clvN++;
      buckets[b].clvSum += clv;
      if (clv > 0) buckets[b].clvPos++;
    }
  }
  const out = {};
  for (const [b, s] of Object.entries(buckets)) {
    out[b] = {
      n: s.n,
      settled: s.settled,
      roi_pct: s.staked > 0 ? +((s.profit / s.staked) * 100).toFixed(2) : null,
      avg_clv_pct: s.clvN > 0 ? +((s.clvSum / s.clvN)).toFixed(2) : null,
      positive_clv_rate: s.clvN > 0 ? +((s.clvPos / s.clvN) * 100).toFixed(1) : null,
      clv_sample: s.clvN,
    };
  }
  return out;
}

function renderTable(label, summary) {
  const rows = ['low', 'mid', 'high'].map(b => {
    const s = summary[b];
    return [
      b,
      String(s.n).padStart(5),
      String(s.settled).padStart(5),
      (s.roi_pct == null ? '—' : `${s.roi_pct.toFixed(2)}%`).padStart(8),
      (s.avg_clv_pct == null ? '—' : `${s.avg_clv_pct.toFixed(2)}%`).padStart(9),
      (s.positive_clv_rate == null ? '—' : `${s.positive_clv_rate.toFixed(1)}%`).padStart(9),
      String(s.clv_sample).padStart(5),
    ].join(' | ');
  });
  return [
    `\n── ${label} ──────────────────────────────────────`,
    'bucket |     n |   set |     ROI |    avgCLV |   posCLV |  clvN',
    '-------|-------|-------|---------|-----------|----------|------',
    ...rows,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Pull all bets relevant to the largest window once; client-side filter per
  // window is goedkoper dan 3 round-trips. odds_bucket selecteren met fallback
  // naar derivatie via lib/picks::oddsBucket(odds) wanneer kolom nog niet
  // bestaat (pre-migratie schema).
  const maxWindow = Math.max(...args.windows);
  const sinceMs = Date.now() - maxWindow * 86400000;
  const sinceDate = new Date(sinceMs);
  // bets.datum is dd-mm-yyyy text, dus we filteren niet server-side; gewoon
  // alle bets van laatste 2× window pakken om roundtrip-overhead te beperken
  // en client-side filteren.
  let query = supabase.from('bets').select('datum, odds, odds_bucket, uitkomst, inzet, wl, clv_pct').limit(50000);
  let { data, error } = await query;
  if (error && /column .*odds_bucket/i.test(error.message || '')) {
    // Pre-migratie schema fallback — strip odds_bucket uit select.
    const retry = await supabase.from('bets').select('datum, odds, uitkomst, inzet, wl, clv_pct').limit(50000);
    if (retry.error) throw new Error(retry.error.message);
    data = retry.data || [];
  } else if (error) {
    throw new Error(error.message);
  }
  data = data || [];

  const allWindows = {};
  for (const w of args.windows) allWindows[`${w}d`] = summarise(data, w);

  if (args.json) {
    const meta = {
      generatedAt: new Date().toISOString(),
      windowDays: args.windows,
      totalRowsRead: data.length,
      sinceISO: sinceDate.toISOString(),
    };
    process.stdout.write(JSON.stringify({ meta, perWindow: allWindows }, null, 2) + '\n');
    return;
  }

  console.log(`\nEdgePickr · odds-bucket-audit · ${data.length} bets gelezen`);
  console.log(`Generated: ${new Date().toISOString()}`);
  for (const [label, summary] of Object.entries(allWindows)) {
    console.log(renderTable(label, summary));
  }
  console.log('\nbucket-grenzen: low ≤2.00 · mid 2.00–3.00 · high >3.00');
  console.log('roi_pct = sum(wl) / sum(inzet) · clvN = bets met clv_pct gevuld');
}

main().catch(e => { console.error(e?.message || e); process.exit(1); });
