'use strict';

const express = require('express');

/**
 * v11.3.8 · Phase 5.4p: Admin-timeline cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminTimelineRouter({...}))`.
 *
 * Verantwoordelijkheden (line-timeline + calibration observability):
 *   - GET /api/admin/v2/calibration-monitor    — signal_calibration Brier/log-loss per window
 *   - GET /api/admin/v2/line-timeline-preview  — price-memory timeline + execution-gate preview
 *
 * @param {object} deps
 *   - supabase          — Supabase client
 *   - requireAdmin      — Express middleware
 *   - loadUsers         — async () → users[] (voor preferred-bookies in timeline)
 *   - lineTimelineLib   — lib/line-timeline module ({ getLineTimeline, deriveExecutionMetrics })
 * @returns {express.Router}
 */
module.exports = function createAdminTimelineRouter(deps) {
  const { supabase, requireAdmin, loadUsers, lineTimelineLib } = deps;

  const required = { supabase, requireAdmin, loadUsers, lineTimelineLib };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminTimelineRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // GET /api/admin/v2/calibration-monitor?window=90d&sport=football
  // Leest per-signaal Brier/log-loss/bins uit signal_calibration. Rows dragen
  // expliciet `probability_source` zodat v1 ep_proxy niet als canonical
  // pick.ep-calibratie gelezen wordt.
  router.get('/admin/v2/calibration-monitor', requireAdmin, async (req, res) => {
    try {
      const window = typeof req.query.window === 'string' ? req.query.window : null;
      const sport = typeof req.query.sport === 'string' ? req.query.sport : null;
      const marketType = typeof req.query.market_type === 'string' ? req.query.market_type : null;
      const allowedWindows = new Set(['30d', '90d', '365d', 'lifetime']);
      let query = supabase.from('signal_calibration')
        .select('*')
        .order('brier_score', { ascending: true, nullsLast: true })
        .limit(2000);
      if (window && allowedWindows.has(window)) query = query.eq('window_key', window);
      if (sport) query = query.eq('sport', sport);
      if (marketType) query = query.eq('market_type', marketType);
      const { data, error } = await query;
      if (error) {
        if (/relation .* does not exist/i.test(error.message || '')) {
          return res.json({ ready: false, reason: 'signal_calibration tabel niet gemigreerd', rows: [] });
        }
        return res.status(500).json({ error: error.message });
      }
      const rows = data || [];
      return res.json({
        ready: true,
        filters: { window, sport, market_type: marketType },
        rowCount: rows.length,
        rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/admin/v2/line-timeline-preview?fixture_id=123&market_type=h2h&selection_key=home&line=2.5&two_way=1
  // Returns timeline + derived execution-gate metrics + what applyExecutionGate zou
  // doen voor een hypothetical kelly fraction (hk=0.05). Observability voor de
  // price-memory pipeline. Verbruikt GEEN api-football quota; alleen supabase read.
  router.get('/admin/v2/line-timeline-preview', requireAdmin, async (req, res) => {
    try {
      const fixtureId = parseInt(req.query.fixture_id, 10);
      const marketType = typeof req.query.market_type === 'string' ? req.query.market_type : 'h2h';
      const selectionKey = typeof req.query.selection_key === 'string' ? req.query.selection_key : null;
      const lineRaw = req.query.line != null && req.query.line !== '' ? parseFloat(req.query.line) : null;
      const twoWay = req.query.two_way === '1' || req.query.two_way === 'true';
      if (!Number.isFinite(fixtureId) || fixtureId <= 0) return res.status(400).json({ error: 'fixture_id is verplicht' });

      let preferredBookies = [];
      try {
        const users = await loadUsers();
        const admin = users.find(u => u.role === 'admin');
        preferredBookies = admin?.settings?.preferredBookies || ['Bet365', 'Unibet'];
      } catch { preferredBookies = ['Bet365', 'Unibet']; }

      let kickoffMs = null;
      try {
        const { data: fxRow } = await supabase.from('fixtures').select('kickoff_time').eq('id', fixtureId).single();
        if (fxRow?.kickoff_time) {
          const t = Date.parse(fxRow.kickoff_time);
          if (Number.isFinite(t)) kickoffMs = t;
        }
      } catch { /* fixtures tabel misschien niet aanwezig; niet-fataal */ }

      const timelineParams = { fixtureId, marketType, preferredBookies };
      if (selectionKey) timelineParams.selectionKey = selectionKey;
      if (lineRaw != null && Number.isFinite(lineRaw)) timelineParams.line = lineRaw;
      if (kickoffMs) timelineParams.kickoffTime = kickoffMs;

      const timelineMap = await lineTimelineLib.getLineTimeline(supabase, timelineParams);
      if (timelineMap.size === 0) {
        return res.json({
          fixtureId, marketType, ready: false,
          reason: 'Geen odds_snapshots gevonden voor deze combinatie',
          buckets: [],
        });
      }

      const { applyExecutionGate } = require('../execution-gate');
      const buckets = [];
      for (const [bucketKey, entry] of timelineMap) {
        const metrics = lineTimelineLib.deriveExecutionMetrics(entry.timeline, { twoWayMarket: twoWay });
        const gated = metrics ? applyExecutionGate(0.05, metrics) : null;
        buckets.push({
          bucketKey,
          selectionKey: entry.selectionKey,
          line: entry.line,
          timeline: entry.timeline,
          metrics,
          simulatedGate: gated ? {
            hk_input: 0.05,
            hk_output: gated.hk,
            combined_multiplier: gated.combinedMultiplier,
            multipliers: gated.multipliers,
            reasons: gated.reasons,
            skipped: gated.skip === true,
          } : null,
        });
      }

      return res.json({
        fixtureId, marketType, preferredBookies, kickoffMs, twoWayMarket: twoWay,
        ready: true,
        bucketCount: buckets.length,
        buckets,
      });
    } catch (e) {
      console.error('line-timeline-preview error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
