'use strict';

const express = require('express');

/**
 * v11.3.16 · Phase 5.4x: Scan SSE streaming routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createScanStreamRouter({...}))`.
 *
 * Endpoints (admin-only):
 *   - POST /api/prematch — SSE pre-match scan met progress/log-events, eindig
 *                          met `{done,picks,combis}`. Gebruikt scanRunning-mutex
 *                          en OPERATOR.master_scan_enabled failsafe.
 *   - POST /api/live     — SSE live scan, projecteert picks minimal voor UI.
 *
 * @param {object} deps
 *   - requireAdmin             — middleware
 *   - rateLimit                — fn (key, maxCount, windowMs) → boolean
 *   - operator                 — object met `master_scan_enabled` boolean
 *   - getScanRunning           — fn () → boolean (mutable flag, gedeeld met cron)
 *   - setScanRunning           — fn (boolean) → void
 *   - loadUsers                — async () → users[]
 *   - runFullScan              — async ({ emit, prefs, isAdmin, triggerLabel }) → { safePicks, safeCombis }
 *   - runLive                  — async (emit) → picks[]
 * @returns {express.Router}
 */
module.exports = function createScanStreamRouter(deps) {
  const {
    requireAdmin,
    rateLimit,
    operator,
    getScanRunning,
    setScanRunning,
    loadUsers,
    runFullScan,
    runLive,
  } = deps;

  const required = {
    requireAdmin, rateLimit, operator,
    getScanRunning, setScanRunning,
    loadUsers, runFullScan, runLive,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createScanStreamRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.post('/prematch', requireAdmin, (req, res) => {
    if (rateLimit('prematch:' + (req.user?.id || 'admin'), 5, 60 * 1000)) return res.status(429).json({ error: 'Te veel scan-triggers · wacht een minuut' });
    if (!operator.master_scan_enabled) return res.status(503).json({ error: 'Scans uitgeschakeld via operator failsafe' });
    if (getScanRunning()) return res.status(429).json({ error: 'Scan al bezig · wacht tot de huidige scan klaar is' });
    setScanRunning(true);
    const isAdmin = true;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let stepCount = 0;
    const emit = (data) => {
      if (!isAdmin && data.log) {
        stepCount++;
        const pct = Math.min(95, Math.round(stepCount * 1.5));
        res.write(`data: ${JSON.stringify({ progress: pct })}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    (async () => {
      let prefs = null;
      try {
        const users = await loadUsers().catch(() => []);
        const me = users.find(u => u.id === req.user?.id) || users.find(u => u.role === 'admin');
        prefs = me?.settings?.preferredBookies || null;
      } catch (e) {
        console.warn('Scan: user prefs load failed, scan loopt zonder filter:', e.message);
      }
      const { safePicks, safeCombis } = await runFullScan({ emit, prefs, isAdmin, triggerLabel: 'manual' });
      emit({ done: true, picks: safePicks, combis: safeCombis || [] });
      res.end();
      setScanRunning(false);
    })().catch(err => {
      const detail = (err && (err.message || err.toString())) || 'unknown';
      console.error('🔴 runFullScan crashed:', detail);
      if (err?.stack) console.error(err.stack);
      emit({ error: 'Scan mislukt', detail });
      res.end();
      setScanRunning(false);
    });
  });

  router.post('/live', requireAdmin, (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimit('live:' + ip, 5, 10 * 60 * 1000)) return res.status(429).json({ error: 'Te veel live scans · wacht even' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    runLive(emit)
      .then(picks => { emit({ done: true, picks: picks.map(p => ({ match: p.match, league: p.league, label: p.label, odd: p.odds||p.odd, prob: p.prob, units: p.units, reason: p.reason })) }); res.end(); })
      .catch(err  => { console.error('Live scan fout:', err.message); emit({ error: 'Live scan mislukt' }); res.end(); });
  });

  return router;
};
