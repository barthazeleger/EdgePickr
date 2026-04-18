'use strict';

function shouldAutoSyncTrackerOnLiveEnd({ wasLive, isLive, alreadyNotifiedFt }) {
  return wasLive === true && isLive === false && alreadyNotifiedFt !== true;
}

// v11.3.23 F4 (Codex #1): detecteer dat een live bet mathematisch al verloren
// is (bijv. Under 2.5 met score reeds 3 goals totaal). Frontend kan deze check
// gebruiken om meteen tracker-sync te triggeren i.p.v. wachten tot full-time.
// Returnt true als markt een irreversibele L is in de huidige live-event.
function isLiveIrreversiblyLost(markt, ev) {
  const market = String(markt || '').toLowerCase();
  const scoreH = Number(ev?.scoreH);
  const scoreA = Number(ev?.scoreA);
  if (!Number.isFinite(scoreH) || !Number.isFinite(scoreA)) return false;
  const total = scoreH + scoreA;

  // Under X.5: totalGoals > line → verloren en onomkeerbaar.
  const underMatch = market.match(/under\s*(\d+\.?\d*)/i);
  if (underMatch) {
    const line = parseFloat(underMatch[1]);
    if (Number.isFinite(line) && total > line) return true;
  }
  // BTTS Nee: beide teams al gescoord → verloren.
  if ((market.includes('btts nee') || market.includes('btts no')) && scoreH > 0 && scoreA > 0) {
    return true;
  }
  return false;
}

function matchesClvRecomputeTarget(row, options = {}) {
  if (!row) return false;
  const targetBetId = Number.isFinite(options.betId) ? options.betId : null;
  if (targetBetId != null) {
    return row.bet_id === targetBetId;
  }
  return true;
}

function resolveEarlyLiveOutcome(markt, ev) {
  const market = String(markt || '').toLowerCase();
  const scoreH = Number(ev?.scoreH);
  const scoreA = Number(ev?.scoreA);
  if (!Number.isFinite(scoreH) || !Number.isFinite(scoreA)) return null;
  const total = scoreH + scoreA;

  const overMatch = market.match(/over\s*(\d+\.?\d*)/i);
  if (overMatch) {
    const line = parseFloat(overMatch[1]);
    if (Number.isFinite(line) && total > line) return 'W';
  }

  const underMatch = !overMatch && market.match(/under\s*(\d+\.?\d*)/i);
  if (underMatch) {
    const line = parseFloat(underMatch[1]);
    if (Number.isFinite(line) && total > line) return 'L';
  }

  const bothScored = scoreH > 0 && scoreA > 0;
  if (bothScored) {
    if (market.includes('btts ja') || market.includes('btts yes') || (market.includes('btts') && !market.includes('nee') && !market.includes('no'))) {
      return 'W';
    }
    if (market.includes('btts nee') || market.includes('btts no')) {
      return 'L';
    }
  }

  return null;
}

module.exports = {
  shouldAutoSyncTrackerOnLiveEnd,
  matchesClvRecomputeTarget,
  resolveEarlyLiveOutcome,
  isLiveIrreversiblyLost,
};
