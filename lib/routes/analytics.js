'use strict';

const express = require('express');

/**
 * v11.3.0 · Phase 5.4h: Analytics read-only routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAnalyticsRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/signal-analysis (admin) — per-signaal hit-rate + avg CLV edge over alle
 *     settled bets met signals. Parseert `signal_name:+1.2%` format.
 *   - GET /api/timing-analysis  (admin) — CLV per timing bucket (>12h vroeg,
 *     3-12h medium, <3h laat voor kickoff). Gebruikt b.tijd + b.datum om
 *     logging-tijd te berekenen, fallback op 20:45 als kickoffTime ontbreekt.
 *
 * @param {object} deps
 *   - requireAdmin  — Express middleware
 *   - readBets      — async (userId) → { bets, stats }
 * @returns {express.Router}
 */
module.exports = function createAnalyticsRouter(deps) {
  const { requireAdmin, readBets } = deps;

  const required = { requireAdmin, readBets };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAnalyticsRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/signal-analysis', requireAdmin, async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets } = await readBets(userId);
      const settledWithSignals = bets.filter(b => (b.uitkomst === 'W' || b.uitkomst === 'L') && b.signals);

      const signalMap = {}; // signalName → { count, wins, totalEdge }

      for (const bet of settledWithSignals) {
        let signals;
        try { signals = JSON.parse(bet.signals); } catch { continue; }
        if (!Array.isArray(signals)) continue;

        const won = bet.uitkomst === 'W';
        const edge = bet.clvPct || 0;

        for (const sig of signals) {
          // Parse signal name from format "name:+1.2%"
          const name = sig.split(':')[0];
          if (!signalMap[name]) signalMap[name] = { count: 0, wins: 0, totalEdge: 0 };
          signalMap[name].count++;
          if (won) signalMap[name].wins++;
          signalMap[name].totalEdge += edge;
        }
      }

      const signalAnalysis = Object.entries(signalMap).map(([name, data]) => ({
        name,
        betsCount: data.count,
        hitRate: +(data.wins / Math.max(1, data.count)).toFixed(3),
        avgEdge: +(data.totalEdge / Math.max(1, data.count)).toFixed(2),
      })).sort((a, b) => b.betsCount - a.betsCount);

      res.json({ signals: signalAnalysis });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // Timing analyse · CLV per timing bucket (uren voor aftrap)
  router.get('/timing-analysis', requireAdmin, async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets } = await readBets(userId);
      const settled = bets.filter(b => b.clvPct != null && b.clvPct !== 0 && b.tijd);
      const buckets = { 'Vroeg (>12h)': [], 'Medium (3-12h)': [], 'Laat (<3h)': [] };

      for (const b of settled) {
        // Parse bet datum + tijd → timestamp. b.datum = "dd-mm-yyyy", b.tijd = "HH:MM".
        if (!b.datum || !b.tijd) continue;
        const [dd, mm, yyyy] = b.datum.split('-').map(Number);
        const [hh, mi] = b.tijd.split(':').map(Number);
        if (!dd || !mm || !yyyy || isNaN(hh) || isNaN(mi)) continue;
        const betTime = new Date(yyyy, mm - 1, dd, hh, mi);

        // Kickoff time: if we have a kickoffTime stored, use it. Otherwise use 20:45 default.
        let kickoffTime = null;
        if (b.kickoffTime) {
          const [kh, km] = b.kickoffTime.split(':').map(Number);
          if (!isNaN(kh) && !isNaN(km)) kickoffTime = new Date(yyyy, mm - 1, dd, kh, km);
        }
        if (!kickoffTime) {
          kickoffTime = new Date(yyyy, mm - 1, dd, 20, 45);
        }

        const hoursBeforeKO = (kickoffTime.getTime() - betTime.getTime()) / 3600000;
        if (hoursBeforeKO < 0) continue; // bet logged after kickoff, skip

        if (hoursBeforeKO > 12) buckets['Vroeg (>12h)'].push(b);
        else if (hoursBeforeKO >= 3) buckets['Medium (3-12h)'].push(b);
        else buckets['Laat (<3h)'].push(b);
      }

      res.json({ buckets: Object.entries(buckets).map(([name, betsInBucket]) => ({
        name,
        count: betsInBucket.length,
        avgCLV: betsInBucket.length ? +(betsInBucket.reduce((s, b) => s + b.clvPct, 0) / betsInBucket.length).toFixed(2) : 0,
        hitRate: betsInBucket.length ? +(betsInBucket.filter(b => b.uitkomst === 'W').length / betsInBucket.length).toFixed(3) : 0
      }))});
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
