'use strict';

const { shouldRunPostResultsModelJobs } = require('./daily-results');

/**
 * v11.3.20 · Phase 6.2c: Scan scheduling (cron) extracted uit server.js.
 *
 * Factory pattern. Gebruik:
 *   const ss = createScanSchedulers({ ... });
 *   ss.scheduleDailyScan();
 *   ss.scheduleDailyResultsCheck();
 *
 * Bevat ook `scheduleScanAtHour` publiek als retourfunctie (wordt gebruikt
 * door rescheduleUserScans in server.js).
 *
 * @param {object} deps
 *   - supabase
 *   - loadUsers                   — async () → users[]
 *   - notify                      — async (text, type?, userId?) → void
 *   - runFullScan                 — async ({ emit, prefs, isAdmin, triggerLabel }) → scanResult
 *   - checkOpenBetResults         — async (userId?) → { checked, updated, results }
 *   - readBets                    — async (userId, money?) → { bets, stats }
 *   - getAdminUserId              — async () → string
 *   - sendPushToAll               — async (payload) → void
 *   - autoTuneSignals             — async () → void
 *   - evaluateKellyAutoStepup     — async () → void
 *   - autoTuneSignalsByClv        — async () → { tuned, muted, ... }
 *   - updateCalibrationMonitor    — async () → { aggregated, error? }
 *   - evaluateActionableTodos     — async () → void
 *   - getScanRunning              — fn () → boolean
 *   - setScanRunning              — fn (boolean) → void
 *   - userScanTimers              — shared mutable map { userId: [timeoutHandle, ...] }
 * @returns {object} schedulers
 */
module.exports = function createScanSchedulers(deps) {
  const {
    supabase, loadUsers, notify,
    runFullScan, checkOpenBetResults,
    readBets, getAdminUserId,
    sendPushToAll,
    autoTuneSignals, evaluateKellyAutoStepup, autoTuneSignalsByClv,
    updateCalibrationMonitor, evaluateActionableTodos,
    getScanRunning, setScanRunning,
    userScanTimers,
    // v15.4.4 optional: scan-complete push uses pick-count uit deze accessor.
    // Als dep ontbreekt valt push terug op generic "open EdgePickr" body.
    getLastPrematchPicks = null,
  } = deps;

  const required = {
    supabase, loadUsers, notify,
    runFullScan, checkOpenBetResults,
    readBets, getAdminUserId,
    sendPushToAll,
    autoTuneSignals, evaluateKellyAutoStepup, autoTuneSignalsByClv,
    updateCalibrationMonitor, evaluateActionableTodos,
    getScanRunning, setScanRunning,
    userScanTimers,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createScanSchedulers: missing required dep '${key}'`);
    }
  }

  const _globalScanTimers = [];

  function scheduleScanAtHour(timeInput) {
    let hour, minute;
    if (typeof timeInput === 'number') { hour = timeInput; minute = 0; }
    else {
      const m = String(timeInput).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return;
      hour = parseInt(m[1]); minute = parseInt(m[2]);
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
    const label = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;

    const now    = new Date();
    const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    const offsetMs = amsNow.getTime() - now.getTime();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    target.setTime(target.getTime() - offsetMs);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
    console.log(`📡 Scan gepland om ${hm} (over ${Math.round(delay/60000)} min)`);
    return setTimeout(async () => {
      console.log(`📡 Scan om ${label} gestart...`);
      try {
        await supabase.from('notifications').insert({
          type: 'cron_tick',
          title: `⏱️ Cron scan ${label} gestart`,
          body: `Scheduler triggered at ${new Date().toISOString()}`,
          read: false, user_id: null,
        });
      } catch {}
      let scanResult = null;
      try {
        if (getScanRunning()) {
          console.log(`⚠️ Scan ${label}: al een scan bezig, skip cron-tik`);
        } else {
          setScanRunning(true);
          try {
            let prefs = null;
            try {
              const users = await loadUsers().catch(() => []);
              const admin = users.find(u => u.role === 'admin');
              prefs = admin?.settings?.preferredBookies || null;
            } catch {}
            scanResult = await runFullScan({
              emit: (d) => { if (d.log) console.log(`[${label}] ${d.log}`); },
              prefs,
              isAdmin: true,
              triggerLabel: `cron-${label}`,
            });
            console.log(`📡 Scan om ${label} klaar`);
          } finally {
            setScanRunning(false);
          }
        }
      } catch (e) {
        console.error(`Scan om ${label} fout:`, e.message);
        await notify(`⚠️ Scan om ${label} mislukt: ${e.message}`).catch(() => {});
      }
      // v15.4.4: scan-complete push (operator-broad). Doctrine PLAN §6 zegt
      // "alleen operator_action + red_flag triggeren push", maar scan-completion
      // valt operationeel onder operator_action (Bart wil weten dát + wát).
      // Frequentie cap: 3 pushes/dag (vaste cron windows) = niet pump-y.
      // Pick-count via getLastPrematchPicks (geinjecteerd) zodat we runFullScan
      // signature niet hoeven te lezen. Bij fout: silent skip — push mag scan-flow
      // nooit breken.
      try {
        let pickCount = null;
        if (typeof getLastPrematchPicks === 'function') {
          try { pickCount = (getLastPrematchPicks() || []).length; }
          catch { pickCount = null; }
        }
        const body = pickCount == null
          ? `Open EdgePickr voor de output.`
          : pickCount === 0
            ? `Geen picks gevonden. Volgende scan staat al ingepland.`
            : `${pickCount} pick${pickCount === 1 ? '' : 's'} klaar — open EdgePickr om te plaatsen.`;
        await sendPushToAll({
          title: `🎯 Scan ${label} klaar`,
          body,
          tag: `scan-complete-${label}`,
          url: '/',
        });
      } catch (e) {
        console.warn(`[scan-complete-push] ${label} faalde silent:`, e?.message || e);
      }
      scheduleScanAtHour(timeInput);
    }, delay);
  }

  // v15.4.2: default-fallback van '07:30' (singleton) naar canonical
  // 3-window doctrine ['11:00','14:30','18:30']. Reden: 07:30 had geen
  // kickoff-cluster in de daaropvolgende 4u, en de eerdere combo
  // 07:30/14:00/21:00 mistte Sat 13:30 PL (14:00 was 30min te laat) plus
  // 21:00 liep synchroon met de 148-fixture evening-peak. Nieuwe windows
  // zijn data-gedreven gepicked op 60d fixtures-distributie (zie CHANGELOG
  // v15.4.2 voor onderbouwing).
  const DEFAULT_SCAN_TIMES = ['11:00', '14:30', '18:30'];
  function scheduleDailyScan() {
    loadUsers().then(users => {
      const admin = users.find(u => u.role === 'admin');
      if (!admin) {
        console.log(`⚠️ scheduleDailyScan: geen admin-user, default-scan op ${DEFAULT_SCAN_TIMES.join(', ')}`);
        for (const t of DEFAULT_SCAN_TIMES) _globalScanTimers.push(scheduleScanAtHour(t));
        return;
      }
      if (userScanTimers[admin.id]) {
        userScanTimers[admin.id].forEach(h => clearTimeout(h));
      }
      const times = admin.settings?.scanTimes?.length ? admin.settings.scanTimes : DEFAULT_SCAN_TIMES;
      console.log(`📅 Admin scan-scheduler: ${times.join(', ')} (scanEnabled=${admin.settings?.scanEnabled !== false})`);
      userScanTimers[admin.id] = times.map(t => scheduleScanAtHour(t));
    }).catch((e) => {
      console.log(`⚠️ scheduleDailyScan: loadUsers faalde, default op ${DEFAULT_SCAN_TIMES.join(', ')}:`, e.message);
      for (const t of DEFAULT_SCAN_TIMES) _globalScanTimers.push(scheduleScanAtHour(t));
    });
  }

  function scheduleDailyResultsCheck() {
    const now    = new Date();
    const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    const offsetMs = amsNow.getTime() - now.getTime();
    const target = new Date(now);
    const amsTarget = new Date(now);
    amsTarget.setHours(10, 0, 0, 0);
    target.setTime(amsTarget.getTime() - offsetMs);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
    console.log(`⏰ Dagelijkse check gepland om ${hm} (over ${Math.round(delay/60000)} min)`);

    setTimeout(async () => {
      console.log('⏰ Dagelijkse uitslag check gestart...');
      let updated = 0;
      try {
        const checkResult = await checkOpenBetResults();
        const { checked, results } = checkResult;
        updated = checkResult.updated;
        const { bets, stats } = await readBets(await getAdminUserId());

        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = (bets || []).filter(b => {
          if (!['W','L'].includes(b.uitkomst)) return false;
          const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (!dm) return false;
          const iso = `${dm[3]}-${dm[2]}-${dm[1]}T${b.tijd || '12:00'}:00`;
          const ms = Date.parse(iso);
          return isFinite(ms) && ms >= cutoff;
        });
        const recentById = new Set(results.map(r => r.id));
        const recentExtra = recent.filter(b => !recentById.has(b.id));

        const lines = [`📋 DAGELIJKSE CHECK · ${new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long' })}`];
        lines.push(`${checked} open bet${checked !== 1 ? 's' : ''} gecontroleerd | ${updated} auto-bijgewerkt`);
        lines.push(`📊 Laatste 24h: ${recent.length} settled bets (inclusief reeds vastgelegde)\n`);

        for (const r of results) {
          const ico = r.uitkomst === 'W' ? '✅' : r.uitkomst === 'L' ? '❌' : '⚠️';
          lines.push(`${ico} ${r.wedstrijd}\n   ${r.markt} | ${r.score} → ${r.uitkomst || 'handmatig'}`);
        }
        for (const b of recentExtra) {
          const ico = b.uitkomst === 'W' ? '✅' : '❌';
          const scoreStr = b.score || '';
          lines.push(`${ico} ${b.wedstrijd}\n   ${b.markt} | ${scoreStr} → ${b.uitkomst}`);
        }
        if (!results.length && !recentExtra.length) lines.push('Geen afgeronde wedstrijden in laatste 24h.');

        lines.push(`\n💰 Bankroll: €${stats.bankroll} | ROI: ${(stats.roi*100).toFixed(1)}%`);
        await notify(lines.join('\n')).catch(() => {});

        const wCount = recent.filter(r => r.uitkomst === 'W').length;
        const lCount = recent.filter(r => r.uitkomst === 'L').length;
        const pushBody = recent.length
          ? `${wCount}W / ${lCount}L · Bankroll: €${stats.bankroll} · ROI: ${(stats.roi*100).toFixed(1)}%`
          : `Geen afgeronde wedstrijden · Bankroll: €${stats.bankroll}`;
        await sendPushToAll({
          title: `📋 Dagelijks overzicht`,
          body: pushBody,
          tag: 'daily-results',
          url: '/',
        }).catch(() => {});
      } catch (e) {
        console.error('Daily check fout:', e);
        await notify(`⚠️ Dagelijkse check mislukt: ${e.message}`).catch(() => {});
      }

      const postResultsDecision = shouldRunPostResultsModelJobs(updated);
      if (postResultsDecision.shouldRun) {
        await autoTuneSignals().catch(e => console.error('Auto-tune fout:', e.message));
        await evaluateKellyAutoStepup().catch(e => console.error('Kelly auto-stepup fout:', e.message));
        const clvTune = await autoTuneSignalsByClv().catch(e => ({ tuned: 0, error: e.message }));
        if (clvTune.tuned > 0) {
          console.log(`📊 CLV autotune: ${clvTune.tuned} signal weights aangepast (${clvTune.muted || 0} gemute)`);
          try {
            const muted = (clvTune.adjustments || []).filter(a => a.reason).slice(0, 3).map(a => `${a.name} (${a.avgClv}%)`).join(', ');
            const top = (clvTune.adjustments || []).filter(a => !a.reason).slice(0, 3).map(a => `${a.name}: ${a.old}→${a.new}`).join(', ');
            await supabase.from('notifications').insert({
              type: 'model_update',
              title: `🧠 Model bijgewerkt: ${clvTune.tuned} signal weights aangepast`,
              body: `${clvTune.muted || 0} signal(s) gemute (CLV ≤ -3%): ${muted || 'geen'}\n${top ? `Aangepast: ${top}` : ''}`,
              read: false, user_id: null,
            });
          } catch { /* swallow */ }
        }

        const calResult = await updateCalibrationMonitor().catch(e => ({ error: e.message }));
        if (calResult?.aggregated > 0) {
          console.log(`📊 Calibration monitor: ${calResult.aggregated} signal×sport×markt×window rows bijgewerkt`);
        } else if (calResult?.error) {
          console.warn(`⚠️ Calibration monitor skip: ${calResult.error}`);
        }
      } else {
        console.log('📭 Geen nieuwe settled bets → auto-tune, Kelly-stepup en calibration monitor overgeslagen');
      }

      await evaluateActionableTodos().catch(e => console.error('Todo-check fout:', e.message));

      scheduleDailyResultsCheck();
    }, delay);
  }

  return {
    scheduleScanAtHour,
    scheduleDailyScan,
    scheduleDailyResultsCheck,
  };
};
