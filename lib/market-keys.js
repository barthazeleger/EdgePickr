'use strict';

const { marketKeyFromBetMarkt } = require('./clv-match');
const { detectMarket } = require('./model-math');

/**
 * v12.2.19 (F4): canonieke single-source voor markt-classificatie.
 *
 * Probleem dat de audit identificeerde: dezelfde markt-string werd
 * door `marketKeyFromBetMarkt` (CLV snapshot-shape) en `detectMarket`
 * (calibration-bucket) onafhankelijk geclassificeerd. F5 markten zijn
 * het canonische bewijs:
 *   - marketKeyFromBetMarkt('F5 Over 4.5') → {market_type: 'f5_total', selection_key: 'over'}
 *   - detectMarket('F5 Over 4.5')         → 'over'  (vermengd met main O/U bucket)
 * Resultaat: F5-picks polluten de main O/U calibratie + CLV-feedback
 * matcht niet 1-op-1 met learning-bucket.
 *
 * Deze module:
 *   1. Biedt één API: `normalizeMarketKey(markt)` → composite output.
 *   2. Detecteert known-asymmetric pairs en logt waarschuwing zodat
 *      drift in CI zichtbaar wordt (geen silent miscompute meer).
 *   3. Houdt bestaande functies werkend (geen breaking change). Nieuwe
 *      consumers migreren naar normalizeMarketKey; oude blijven werken.
 *
 * Toekomstige stap: logica daadwerkelijk samenvouwen in deze module en
 * bestaande functies thin wrappers maken. Vereist careful refactor met
 * grote test-suite — gefaseerd uitvoeren.
 */

// Bekend gedocumenteerde asymmetrieën — niet (per ongeluk) als drift loggen.
// Tot we de calibration-buckets synchroniseren met clv-shapes is dit de
// status quo. Een toevoeging hier is een bewust contract met de operator.
const KNOWN_ASYMMETRIC_MARKET_TYPES = new Set([
  'f5_total',  // calibration mixt F5 in main 'over'/'under' bucket (audit-finding)
  'nrfi',      // detectMarket geeft 'nrfi'/'yrfi'; CLV gebruikt {market_type:'nrfi', selection_key:'yes'/'no'}
]);

/**
 * @param {string} markt — bv. "🏠 Bayern wint", "Over 2.5", "F5 Over 4.5 runs"
 * @param {object} opts — pass-through naar marketKeyFromBetMarkt (sport context etc)
 * @returns {object|null}
 *   - clvShape:        {market_type, selection_key, line}|null  (= marketKeyFromBetMarkt)
 *   - learningBucket:  string                                    (= detectMarket; 'other' fallback)
 *   - asymmetric:      boolean — true als known-asymmetric paar
 *   - canonical:       string — stabiele key voor cross-system gebruik
 */
function normalizeMarketKey(markt, opts = {}) {
  if (!markt || typeof markt !== 'string') return null;
  const clvShape = marketKeyFromBetMarkt(markt, opts);
  const learningBucket = detectMarket(markt);
  const asymmetric = clvShape ? KNOWN_ASYMMETRIC_MARKET_TYPES.has(clvShape.market_type) : false;
  // Canonical key: gebruikt clvShape als available (meer specifiek), anders learningBucket.
  let canonical;
  if (clvShape) {
    const linePart = clvShape.line == null ? '' : `/${clvShape.line}`;
    canonical = `${clvShape.market_type}/${clvShape.selection_key}${linePart}`;
  } else {
    canonical = learningBucket || 'unknown';
  }
  return { clvShape, learningBucket, asymmetric, canonical };
}

/**
 * Cross-consistency check: voor een markt-string moeten clvShape en
 * learningBucket compatible zijn (geen onverwachte drift). Returnt
 * `null` als consistent, anders een warning-record.
 *
 * Gebruik: in CI of als runtime-watchdog. Niet in hot path.
 */
function detectMarketKeyDrift(markt, opts = {}) {
  const norm = normalizeMarketKey(markt, opts);
  if (!norm) return null;
  if (norm.asymmetric) return null; // known + intentional
  if (!norm.clvShape) return null;  // clv-shape is null voor exotische markten — niet als drift loggen
  // Soft consistency check: clvShape.market_type moet substring-match hebben met learningBucket
  // (bv. clvShape='moneyline' / 'home' → learningBucket='home' of 'home60').
  const cs = norm.clvShape;
  const lb = norm.learningBucket;
  const sel = cs.selection_key;
  // Acceptable mappings:
  if (cs.market_type === 'moneyline' && (lb === sel || lb === `${sel}60`)) return null;
  if (cs.market_type === 'threeway' && (lb === `${sel}60` || lb === sel)) return null;
  if (cs.market_type === 'total' && (lb === sel || lb === `${sel}`)) return null;
  if (cs.market_type === 'btts' && lb === `btts_${sel}`) return null;
  if (cs.market_type.startsWith('team_total_') && (lb === `team_total_${sel}` || lb === sel)) return null;
  // Anders: drift gedetecteerd
  return {
    markt,
    clvShape: cs,
    learningBucket: lb,
    reason: `clvShape ${cs.market_type}/${sel} ↔ learningBucket '${lb}' niet expected`,
  };
}

module.exports = {
  normalizeMarketKey,
  detectMarketKeyDrift,
  KNOWN_ASYMMETRIC_MARKET_TYPES,
};
