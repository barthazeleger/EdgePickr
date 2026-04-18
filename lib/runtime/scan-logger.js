'use strict';

/**
 * Schrijft een `scan_end` notificatie naar de notifications-tabel. Dit fireert
 * onvoorwaardelijk aan het einde van elke scan (ook bij 0 picks of bij
 * gedeeltelijke sport-fouten), zodat de scan-heartbeat watcher weet dat de
 * scheduler leeft. Voorheen keek heartbeat alleen naar `cron_tick` (scan-start)
 * + `scan_final_selection` (nooit bestaan-type) + `unit_change`. Manual scans
 * produceerden geen notificatie en konden niet meetellen → false-positive
 * SCANNER STIL alerts.
 *
 * @param {object} supabase — Supabase client of mock met .from().insert() chain
 * @param {object} args
 *   - triggerLabel: 'cron-0730' | 'cron-1400' | 'cron-2100' | 'manual' | etc.
 *   - picksCount: aantal picks dat in de finale selectie terechtkwam
 *   - candidatesCount: totaal aantal kandidaten vóór filters
 *   - durationMs: totale scan-duur in ms
 *   - sports: array van gescande sport-strings
 * @returns {Promise<boolean>} true als insert slaagde
 */
async function logScanEnd(supabase, args = {}) {
  if (!supabase || typeof supabase.from !== 'function') return false;
  const {
    triggerLabel = 'unknown',
    picksCount = 0,
    candidatesCount = 0,
    durationMs = 0,
    sports = [],
  } = args;
  try {
    const secs = Math.max(0, Math.round(durationMs / 1000));
    const body = `${picksCount} picks uit ${candidatesCount} kandidaten · ${secs}s${sports.length ? ` · sporten: ${sports.join(', ')}` : ''}`;
    const result = await supabase.from('notifications').insert({
      type: 'scan_end',
      title: `✅ Scan ${triggerLabel} klaar`,
      body,
      read: false,
      user_id: null,
    });
    if (result && result.error) {
      console.warn('[scan-logger] logScanEnd insert returned error:', result.error.message || result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[scan-logger] logScanEnd failed:', e?.message || e);
    return false;
  }
}

/**
 * Pure helper: bepaalt of een set recent-notifications-typen voldoende bewijs
 * is dat de scanner leeft. Heartbeat query geeft rows uit last 14h terug;
 * hasRecentScanActivity returnt true als er minstens 1 row is met een van de
 * geaccepteerde types.
 */
function hasRecentScanActivity(rows, acceptedTypes = new Set(['cron_tick', 'scan_end', 'unit_change'])) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some(r => r && acceptedTypes.has(r.type));
}

module.exports = { logScanEnd, hasRecentScanActivity };
