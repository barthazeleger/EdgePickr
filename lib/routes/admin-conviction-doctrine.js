'use strict';

const express = require('express');
const { evaluateConvictionDoctrine, formatDoctrineDecision } = require('../conviction-doctrine');

/**
 * v12.5.1 · Conviction-doctrine endpoints.
 *
 * Mount via `app.use('/api', createAdminConvictionDoctrineRouter({...}))`.
 *
 * Endpoints:
 *   - GET  /admin/v2/conviction-doctrine          — read-only inspect (huidige stand + decision-aanbeveling)
 *   - POST /admin/v2/conviction-doctrine/apply    — operator-toggle van OPERATOR.conviction_route_disabled
 *
 * De wekelijkse `scheduleConvictionDoctrineReview` (lib/runtime/maintenance-
 * schedulers.js) draait dezelfde evaluator + auto-toepasst alleen de revert-
 * richting. Operator gebruikt deze endpoints voor handmatige inspectie of om
 * te re-enablen na auto-revert.
 *
 * @param {object} deps
 *   - supabase
 *   - requireAdmin
 *   - operator                — de OPERATOR-state mutable object
 *   - saveOperatorState       — async () → void (persist naar admin user settings)
 * @returns {express.Router}
 */
module.exports = function createAdminConvictionDoctrineRouter(deps) {
  const { supabase, requireAdmin, operator, saveOperatorState } = deps;

  const required = { supabase, requireAdmin, operator, saveOperatorState };
  for (const [key, val] of Object.entries(required)) {
    if (val == null) throw new Error(`createAdminConvictionDoctrineRouter: missing dep "${key}"`);
  }

  const router = express.Router();

  router.get('/admin/v2/conviction-doctrine', requireAdmin, async (req, res) => {
    try {
      const windowDays = Math.max(1, Math.min(60, parseInt(req.query.window_days, 10) || 14));
      const minSamples = Math.max(10, Math.min(1000, parseInt(req.query.min_samples, 10) || 100));
      const evaluation = await evaluateConvictionDoctrine({ supabase, windowDays, minSamples });
      const summary = formatDoctrineDecision(evaluation);
      return res.json({
        ...evaluation,
        currentlyDisabled: !!operator.conviction_route_disabled,
        summary,
      });
    } catch (e) {
      console.error('[conviction-doctrine]', e?.message || e);
      return res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  router.post('/admin/v2/conviction-doctrine/apply', requireAdmin, async (req, res) => {
    try {
      const action = req.body?.action;
      if (action !== 'enable' && action !== 'disable') {
        return res.status(400).json({ error: 'action moet "enable" of "disable" zijn' });
      }
      const desired = action === 'disable';
      operator.conviction_route_disabled = desired;
      try { await saveOperatorState(); }
      catch (e) { console.warn('[conviction-doctrine] saveOperatorState failed:', e?.message || e); }
      return res.json({
        ok: true,
        conviction_route_disabled: desired,
        note: desired
          ? 'Conviction-route loosening uit. mkP epGap valt terug naar v12.4.x voor sigCount≥6 (0.03).'
          : 'Conviction-route loosening aan. mkP epGap=0.02 voor sigCount≥6.',
      });
    } catch (e) {
      console.error('[conviction-doctrine apply]', e?.message || e);
      return res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
