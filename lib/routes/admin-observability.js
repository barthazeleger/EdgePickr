'use strict';

const express = require('express');

/**
 * v11.3.1 · Phase 5.4i: Admin observability routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminObservabilityRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/admin/supabase-usage — pg_database_size_bytes + row counts per
 *     tabel; toont % gebruikt van 500MB free-tier limit.
 *   - GET /api/admin/scheduler-status — admin scanTimes + nextFire per slot +
 *     activeTimers count. Gebruikt getUserScanTimers(userId) getter voor
 *     in-memory timer-registry.
 *
 * @param {object} deps
 *   - supabase            — Supabase client
 *   - requireAdmin        — Express middleware
 *   - loadUsers           — async () → array
 *   - getUserScanTimers   — (userId) → array (module-level timer registry getter)
 *   - supabaseUrl         — optional string (voor dashboard link)
 * @returns {express.Router}
 */
module.exports = function createAdminObservabilityRouter(deps) {
  const { supabase, requireAdmin, loadUsers, getUserScanTimers } = deps;
  const supabaseUrl = deps.supabaseUrl || null;

  const required = { supabase, requireAdmin, loadUsers, getUserScanTimers };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminObservabilityRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/admin/supabase-usage', requireAdmin, async (req, res) => {
    try {
      const FREE_TIER_BYTES = 500 * 1024 * 1024; // 500 MB
      // DB size via pg_database_size RPC
      let dbBytes = null;
      try {
        const { data } = await supabase.rpc('pg_database_size_bytes');
        if (typeof data === 'number') dbBytes = data;
      } catch (e) {
        console.warn('supabase-usage: pg_database_size_bytes RPC failed, using row-count fallback:', e.message);
      }
      // Fallback: schat op basis van row counts van belangrijke tabellen.
      const tables = [
        'bets', 'fixtures', 'odds_snapshots', 'feature_snapshots',
        'market_consensus', 'pick_candidates', 'model_runs', 'signal_stats',
        'training_examples', 'raw_api_events', 'execution_logs',
        'notifications', 'users', 'push_subscriptions', 'scan_history', 'calibration', 'signal_weights'
      ];
      const counts = {};
      for (const t of tables) {
        try {
          const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
          counts[t] = error ? null : (count || 0);
        } catch { counts[t] = null; }
      }
      res.json({
        dbBytes,
        freeTierBytes: FREE_TIER_BYTES,
        usedPct: dbBytes ? Math.round(dbBytes / FREE_TIER_BYTES * 100) : null,
        dbMB: dbBytes ? +(dbBytes / 1024 / 1024).toFixed(1) : null,
        freeMB: 500,
        rowCounts: counts,
        dashboardUrl: supabaseUrl ? supabaseUrl.replace(/\.supabase\.co.*$/, '.supabase.co') + '/dashboard' : null,
        note: dbBytes === null ? 'pg_database_size_bytes RPC niet beschikbaar — toont alleen row counts. Voor exacte DB-grootte: Supabase dashboard → Settings → Usage.' : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/scheduler-status', requireAdmin, async (req, res) => {
    try {
      const users = await loadUsers().catch(() => []);
      const admin = users.find(u => u.role === 'admin');
      const times = admin?.settings?.scanTimes?.length ? admin.settings.scanTimes : ['07:30'];
      const enabled = admin?.settings?.scanEnabled !== false;
      const now = new Date();
      const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
      const offsetMs = amsNow.getTime() - now.getTime();
      const upcoming = times.map(t => {
        const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return { time: t, error: 'bad format' };
        const target = new Date(now);
        target.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
        target.setTime(target.getTime() - offsetMs);
        if (target <= now) target.setDate(target.getDate() + 1);
        return {
          time: t,
          nextFire: target.toISOString(),
          nextFireLocal: target.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
          inMinutes: Math.round((target - now) / 60000),
        };
      }).sort((a, b) => (a.inMinutes || 0) - (b.inMinutes || 0));
      const activeTimers = admin ? (getUserScanTimers(admin.id)?.length || 0) : 0;
      res.json({
        adminId: admin?.id || null,
        scanEnabled: enabled,
        configuredTimes: times,
        activeTimers,
        upcoming,
        serverNow: now.toISOString(),
        amsNow: amsNow.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
