'use strict';

// v12.3.0: `check_failed` weggehaald uit persistent set. Voorheen kon operator
// gefaalde CLV-checks niet via "Wis alles" verwijderen — operationele ruis,
// geen audit-event. `clv_backfill` blijft persistent (audit trail van wat is
// teruggevuld). Andere types blijven persistent: stake-regime transitions,
// drift alerts, kill-switch state changes — daadwerkelijke audit-data.
const PERSISTENT_INBOX_NOTIFICATION_TYPES = new Set([
  'stake_regime_transition',
  'odds_drift',
  'heartbeat_miss',
  'clv_backfill',
  'clv_milestone',
  'drift_alert',
  'drawdown_alert',
  'kill_switch',
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
