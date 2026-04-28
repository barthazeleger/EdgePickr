'use strict';

const SHADOW_SIGNAL_NAMES = new Set([
  'stakes',
  'nfl_injury_diff',
  'nba_rest_days_diff',
  'nba_injury_diff',
  'nhl_injury_diff',
  'mlb_injury_diff',
  'handball_injury_diff',
  'early_payout',
  'sharp_anchor',
]);

const SHADOW_SIGNAL_PREFIXES = [
  'fixture_congestion',
  'rest_days',
  'rest_mismatch',
  'tsdb_',
  'event_stats',
  'event_timeline',
  'lineup_',
  'venue_',
  'roster_',
  'source_disagreement',
];

function signalWeightKeys({ sport, marketType, signal } = {}) {
  const s = String(sport || '').trim();
  const m = String(marketType || '').trim();
  const sig = String(signal || '').trim();
  if (!sig) return [];
  const keys = [];
  if (s && m) keys.push(`${s}:${m}:${sig}`);
  if (s) keys.push(`${s}:${sig}`);
  keys.push(sig);
  return keys;
}

function parseSignalWeightKey(key) {
  const parts = String(key || '').split(':').filter(Boolean);
  if (parts.length >= 3) {
    return {
      sport: parts[0],
      marketType: parts[1],
      signal: parts.slice(2).join(':'),
      level: 'sport_market',
    };
  }
  if (parts.length === 2) {
    return { sport: parts[0], marketType: null, signal: parts[1], level: 'sport' };
  }
  return { sport: null, marketType: null, signal: parts[0] || '', level: 'global' };
}

function defaultSignalWeight(signal) {
  const name = String(signal || '').trim();
  if (!name) return 1.0;
  if (SHADOW_SIGNAL_NAMES.has(name)) return 0;
  if (SHADOW_SIGNAL_PREFIXES.some(prefix => name === prefix || name.startsWith(`${prefix}_`) || name.startsWith(prefix))) return 0;
  return 1.0;
}

function readWeightValue(value) {
  if (Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && Number.isFinite(value.weight)) return value.weight;
  return null;
}

function resolveSignalWeight(weights = {}, context = {}, opts = {}) {
  const keys = signalWeightKeys(context);
  const signal = context.signal || parseSignalWeightKey(keys[keys.length - 1] || '').signal;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(weights || {}, key)) continue;
    const value = readWeightValue(weights[key]);
    if (value != null) return { weight: value, key, level: parseSignalWeightKey(key).level, defaulted: false };
  }
  const fallback = Number.isFinite(opts.defaultWeight) ? opts.defaultWeight : defaultSignalWeight(signal);
  return { weight: fallback, key: null, level: 'default', defaulted: true };
}

module.exports = {
  signalWeightKeys,
  parseSignalWeightKey,
  defaultSignalWeight,
  resolveSignalWeight,
};
