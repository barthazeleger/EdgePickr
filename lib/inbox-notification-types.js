'use strict';

const PERSISTENT_INBOX_NOTIFICATION_TYPES = new Set([
  'stake_regime_transition',
  'odds_drift',
  'heartbeat_miss',
  'clv_backfill',
  'clv_milestone',
  'drift_alert',
  'drawdown_alert',
  'kill_switch',
  'check_failed',
  'api_warning',
  'autotune_run',
]);

function isPersistentInboxNotificationType(type) {
  return PERSISTENT_INBOX_NOTIFICATION_TYPES.has(String(type || '').trim());
}

module.exports = {
  PERSISTENT_INBOX_NOTIFICATION_TYPES,
  isPersistentInboxNotificationType,
};
