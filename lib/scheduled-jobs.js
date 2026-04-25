'use strict';

/**
 * v12.2.14 (D1): persistent scheduled jobs store.
 *
 * Probleem: schedulePreKickoffCheck + scheduleCLVCheck draaien als
 * in-memory setTimeout. Bij Render free-tier spindown of crash gaan
 * pending timers verloren — pre-kickoff drift-alerts en CLV-snapshots
 * worden gemist.
 *
 * Aanpak: hybrid setTimeout + DB persistence.
 * - enqueue(): schrijft row naar Supabase + start setTimeout (voor
 *   low-latency firing als process levend blijft)
 * - run-callback bij setTimeout-fire: execute + markComplete
 * - rescheduleAllPending() bij boot: scan DB voor pending rows die
 *   nog niet voorbij de TTL zijn, start setTimeouts opnieuw
 * - sweep() periodiek: ruim completed > 7d op, log overdue (>1h te laat)
 *
 * Job-handlers moeten idempotent zijn: bij race tussen setTimeout-fire
 * en boot-rescan kan een job dubbel draaien. Pre-kickoff en CLV-check
 * zijn beide idempotent (API-fetch + notify, geen state-mutatie).
 *
 * Graceful zonder migratie: als `scheduled_jobs` tabel ontbreekt,
 * vervalt 't naar setTimeout-only (huidige gedrag). Console.warn ipv
 * hard error.
 */

const RELATION_MISSING_RE = /relation.*does not exist/i;

function createScheduledJobsStore({ supabase, handlers = {}, logger = console }) {
  // In-memory tracker voor actieve setTimeouts: jobId → timeoutHandle.
  // Voorkomt dubbele schedules na boot-rescan + setTimeout fire.
  const activeTimers = new Map();

  function _table() {
    return supabase ? supabase.from('scheduled_jobs') : null;
  }

  async function _markComplete(id) {
    if (!_table()) return;
    try {
      const { error } = await _table()
        .update({ completed_at: new Date().toISOString() })
        .eq('id', id);
      if (error && !RELATION_MISSING_RE.test(String(error.message || ''))) {
        logger.warn('[scheduled-jobs] markComplete failed:', error.message);
      }
    } catch (e) {
      logger.warn('[scheduled-jobs] markComplete exception:', e.message);
    }
  }

  async function _markError(id, err) {
    if (!_table()) return;
    try {
      const msg = String(err?.message || err).slice(0, 500);
      const { data: row } = await _table().select('attempts').eq('id', id).single();
      const attempts = (row?.attempts || 0) + 1;
      const { error } = await _table()
        .update({ attempts, last_error: msg })
        .eq('id', id);
      if (error && !RELATION_MISSING_RE.test(String(error.message || ''))) {
        logger.warn('[scheduled-jobs] markError failed:', error.message);
      }
    } catch (e) {
      logger.warn('[scheduled-jobs] markError exception:', e.message);
    }
  }

  async function _runJob(jobRow) {
    const handler = handlers[jobRow.job_type];
    if (!handler) {
      logger.warn(`[scheduled-jobs] no handler for type='${jobRow.job_type}'`);
      await _markComplete(jobRow.id); // markeer voltooid om herhaalde re-runs te voorkomen
      return;
    }
    try {
      await handler(jobRow.payload || {}, jobRow);
      await _markComplete(jobRow.id);
    } catch (err) {
      logger.error(`[scheduled-jobs] job ${jobRow.id} (${jobRow.job_type}) failed:`, err.message);
      await _markError(jobRow.id, err);
    } finally {
      activeTimers.delete(jobRow.id);
    }
  }

  function _scheduleTimer(jobRow) {
    const due = Date.parse(jobRow.due_at);
    if (!Number.isFinite(due)) return;
    const delay = Math.max(0, due - Date.now());
    if (delay > 48 * 3600 * 1000) return; // te ver weg, sweep pakt het later op
    if (activeTimers.has(jobRow.id)) return; // al gepland
    const t = setTimeout(() => _runJob(jobRow).catch(e => logger.error('[scheduled-jobs] runJob:', e.message)), delay);
    activeTimers.set(jobRow.id, t);
  }

  /**
   * Plan een nieuwe job. Persisteert naar DB en start setTimeout.
   * @returns {Promise<{id: number} | null>}
   */
  async function enqueue({ user_id = null, job_type, bet_id = null, payload = {}, due_at }) {
    if (!job_type || !due_at) throw new Error('enqueue: job_type and due_at required');
    if (!_table()) {
      // Geen Supabase — alleen in-memory
      const fakeRow = { id: -Date.now(), job_type, bet_id, payload, due_at, attempts: 0 };
      _scheduleTimer(fakeRow);
      return { id: fakeRow.id };
    }
    try {
      const { data, error } = await _table().insert({
        user_id, job_type, bet_id, payload, due_at: new Date(due_at).toISOString(),
      }).select('id, job_type, bet_id, payload, due_at, attempts').single();
      if (error) {
        if (RELATION_MISSING_RE.test(String(error.message || ''))) {
          logger.warn('[scheduled-jobs] table missing, in-memory only');
          const fakeRow = { id: -Date.now(), job_type, bet_id, payload, due_at, attempts: 0 };
          _scheduleTimer(fakeRow);
          return { id: fakeRow.id };
        }
        throw new Error(error.message);
      }
      _scheduleTimer(data);
      return { id: data.id };
    } catch (e) {
      logger.warn('[scheduled-jobs] enqueue failed, fallback in-memory:', e.message);
      const fakeRow = { id: -Date.now(), job_type, bet_id, payload, due_at, attempts: 0 };
      _scheduleTimer(fakeRow);
      return { id: fakeRow.id };
    }
  }

  /**
   * Bij server boot: scan pending jobs en (re)schedule timers.
   * Skipt jobs die al > 1u te laat zijn (markeer als overdue, geen re-run).
   */
  async function rescheduleAllPending() {
    if (!_table()) return 0;
    try {
      const cutoffPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const cutoffFuture = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      const { data, error } = await _table()
        .select('id, job_type, bet_id, payload, due_at, attempts')
        .is('completed_at', null)
        .gte('due_at', cutoffPast)
        .lte('due_at', cutoffFuture)
        .order('due_at', { ascending: true })
        .limit(500);
      if (error) {
        if (!RELATION_MISSING_RE.test(String(error.message || ''))) {
          logger.warn('[scheduled-jobs] rescheduleAll failed:', error.message);
        }
        return 0;
      }
      let scheduled = 0;
      for (const row of (data || [])) {
        _scheduleTimer(row);
        scheduled++;
      }
      logger.log(`[scheduled-jobs] rescheduled ${scheduled} pending jobs`);
      return scheduled;
    } catch (e) {
      logger.warn('[scheduled-jobs] rescheduleAll exception:', e.message);
      return 0;
    }
  }

  /**
   * Sweep periodiek:
   * - completed > 7d → DELETE
   * - pending > 1u te laat (gemist) → markeer als error met note
   */
  async function sweep() {
    if (!_table()) return;
    try {
      const completedCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      await _table().delete().lt('completed_at', completedCutoff).then(({ error }) => {
        if (error && !RELATION_MISSING_RE.test(String(error.message || ''))) {
          logger.warn('[scheduled-jobs] sweep delete failed:', error.message);
        }
      });
      const overdueCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: overdue } = await _table()
        .select('id')
        .is('completed_at', null)
        .lt('due_at', overdueCutoff)
        .limit(100);
      if (Array.isArray(overdue) && overdue.length) {
        await _table()
          .update({ completed_at: new Date().toISOString(), last_error: 'overdue: missed by sweep' })
          .in('id', overdue.map(r => r.id))
          .then(({ error }) => {
            if (error && !RELATION_MISSING_RE.test(String(error.message || ''))) {
              logger.warn('[scheduled-jobs] sweep mark-overdue failed:', error.message);
            }
          });
        logger.warn(`[scheduled-jobs] marked ${overdue.length} jobs as overdue`);
      }
    } catch (e) {
      logger.warn('[scheduled-jobs] sweep exception:', e.message);
    }
  }

  /**
   * Voor tests/cleanup: cancel alle in-memory timers.
   */
  function _cancelAllTimers() {
    for (const t of activeTimers.values()) clearTimeout(t);
    activeTimers.clear();
  }

  return {
    enqueue,
    rescheduleAllPending,
    sweep,
    _activeTimers: activeTimers,
    _cancelAllTimers,
  };
}

module.exports = { createScheduledJobsStore };
