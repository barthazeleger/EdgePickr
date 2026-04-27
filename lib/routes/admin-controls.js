'use strict';

const express = require('express');

/**
 * v11.3.2 · Phase 5.4j: Admin-controls cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminControlsRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET  /api/admin/v2/kill-switch   — huidige state (enabled, activeKills, thresholds)
 *   - POST /api/admin/v2/kill-switch   — toggle enabled, manual add/remove keys, refresh
 *   - GET  /api/admin/v2/operator      — OPERATOR state + kill-switch active count
 *   - POST /api/admin/v2/operator      — failsafe-toggles (master_scan_enabled, panic_mode, etc.)
 *   - POST /api/admin/v2/upgrade-ack   — dismiss upgrade_api / upgrade_unit aanbevelingen
 *
 * @param {object} deps
 *   - requireAdmin         — Express middleware
 *   - killSwitch           — KILL_SWITCH shared state object (enabled, set, thresholds, lastRefreshed)
 *   - refreshKillSwitch    — async () → void (manual refresh hook)
 *   - operator             — OPERATOR shared state object (master_scan_enabled, panic_mode, etc.)
 *   - saveOperatorState    — async () → void (persist OPERATOR naar Supabase)
 *   - loadCalib            — fn () → calibration object
 *   - saveCalib            — async (c) → void
 * @returns {express.Router}
 */
module.exports = function createAdminControlsRouter(deps) {
  const {
    requireAdmin, killSwitch, refreshKillSwitch,
    operator, saveOperatorState, loadCalib, saveCalib,
  } = deps;

  const required = { requireAdmin, killSwitch, refreshKillSwitch, operator, saveOperatorState, loadCalib, saveCalib };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminControlsRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/admin/v2/kill-switch', requireAdmin, (req, res) => {
    res.json({
      enabled: killSwitch.enabled,
      activeKills: [...killSwitch.set],
      thresholds: killSwitch.thresholds,
      lastRefreshed: killSwitch.lastRefreshed ? new Date(killSwitch.lastRefreshed).toISOString() : null,
    });
  });

  router.post('/admin/v2/kill-switch', requireAdmin, async (req, res) => {
    try {
      const { enabled, addKey, removeKey, refresh } = req.body || {};
      if (typeof enabled === 'boolean') killSwitch.enabled = enabled;
      if (typeof addKey === 'string' && addKey) killSwitch.set.add(addKey);
      if (typeof removeKey === 'string' && removeKey) killSwitch.set.delete(removeKey);
      if (refresh) await refreshKillSwitch();
      res.json({
        enabled: killSwitch.enabled,
        activeKills: [...killSwitch.set],
        lastRefreshed: killSwitch.lastRefreshed ? new Date(killSwitch.lastRefreshed).toISOString() : null,
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // v10.9.6: dismiss permanent een upgrade-aanbeveling. Body: { type, dismissed }.
  router.post('/admin/v2/upgrade-ack', requireAdmin, async (req, res) => {
    try {
      const valid = new Set(['upgrade_api', 'upgrade_unit']);
      const type = String(req.body?.type || '');
      if (!valid.has(type)) return res.status(400).json({ error: 'unknown type; allowed: upgrade_api, upgrade_unit' });
      const dismissed = req.body?.dismissed !== false;
      const cs = loadCalib();
      cs.upgrades_dismissed = cs.upgrades_dismissed || {};
      cs.upgrades_dismissed[type] = dismissed;
      await saveCalib(cs);
      res.json({ ok: true, type, dismissed });
    } catch (e) {
      // v11.3.23 H3: no raw e.message to client.
      console.error('[admin-controls]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  router.get('/admin/v2/operator', requireAdmin, (req, res) => {
    res.json({ ...operator, kill_switch_active_count: killSwitch.set.size });
  });

  router.post('/admin/v2/operator', requireAdmin, async (req, res) => {
    const allowed = ['master_scan_enabled', 'market_auto_kill_enabled', 'signal_auto_kill_enabled', 'panic_mode', 'max_picks_per_day', 'scraping_enabled'];
    const scrapingChanged = req.body && req.body.scraping_enabled !== undefined
      && !!req.body.scraping_enabled !== !!operator.scraping_enabled;
    for (const k of allowed) {
      if (req.body && req.body[k] !== undefined) {
        operator[k] = (k === 'max_picks_per_day') ? Math.max(1, Math.min(10, parseInt(req.body[k]) || 5)) : !!req.body[k];
      }
    }
    killSwitch.enabled = operator.market_auto_kill_enabled;
    await saveOperatorState();
    // v12.5.7: master scraping_enabled toggle propageert naar alle known
    // sources. Voorheen moest operator master ÉN elke per-source apart
    // aanzetten — verwarrend en silent-failure (master aan + per-source uit
    // = scrapers worden aangeroepen maar returnen null op `if (!isSourceEnabled(...))`).
    // Per-source override blijft beschikbaar via /admin/v2/scrape-sources voor
    // specifieke disable. Bij master uit: alle per-source ook uit (anders
    // blijft state-inconsistent).
    if (scrapingChanged) {
      try {
        const scraperBase = require('../integrations/scraper-base');
        const known = ['sofascore', 'fotmob', 'thesportsdb', 'nba-stats', 'nhl-api', 'mlb-stats-ext'];
        const desired = !!operator.scraping_enabled;
        const cs = loadCalib();
        cs.scraper_sources = cs.scraper_sources || {};
        let touched = 0;
        for (const name of known) {
          scraperBase.setSourceEnabled(name, desired);
          cs.scraper_sources[name] = desired;
          touched++;
        }
        await saveCalib(cs).catch(() => {});
        console.log(`🔌 Master scraping toggled ${desired ? 'AAN' : 'UIT'} → ${touched} sources gepropageerd`);
      } catch (e) { console.warn('[admin-controls] scrape-sources propagatie failed:', e?.message || e); }
    }
    res.json({ ...operator, kill_switch_active_count: killSwitch.set.size });
  });

  return router;
};
