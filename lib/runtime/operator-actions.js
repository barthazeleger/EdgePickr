'use strict';

function shouldAutoSyncTrackerOnLiveEnd({ wasLive, isLive, alreadyNotifiedFt }) {
  return wasLive === true && isLive === false && alreadyNotifiedFt !== true;
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
};
