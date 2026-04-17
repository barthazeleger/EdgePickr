'use strict';

const V1_LIVE_STATUSES = new Set([
  'Q1', 'Q2', 'Q3', 'Q4',
  'OT', 'BT', 'HT', 'LIVE',
  'P1', 'P2', 'P3',
  'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9',
]);

function isV1LiveStatus(statusShort) {
  return V1_LIVE_STATUSES.has(String(statusShort || '').toUpperCase());
}

function shouldIncludeDatedV1Game(statusShort, options = {}) {
  const st = String(statusShort || '').toUpperCase();
  if (st === 'NS') return true;
  if (options.includeLiveStatuses === true && isV1LiveStatus(st)) return true;
  return false;
}

module.exports = {
  V1_LIVE_STATUSES,
  isV1LiveStatus,
  shouldIncludeDatedV1Game,
};
