'use strict';

const express = require('express');

/**
 * v11.3.23 · Phase 7.1 · H1 · Public health endpoint voor keep-alive.
 *
 * Reviewer Codex #2 vond dat de Render keep-alive self-ping (`server.js` ~14
 * min interval) `/api/status` hitte zonder auth-header, maar `/api/status`
 * staat sinds v10.10.22 niet meer in `PUBLIC_PATHS`. Resultaat: 401, dus geen
 * effectieve anti-sleep-ping.
 *
 * Oplossing: dedicated minimal `/api/health` endpoint met alleen `{ ok, ts }`,
 * explicit in `PUBLIC_PATHS`. Geen model-stats, geen API-usage, geen user info
 * — zodat `/api/status` privaat kan blijven voor zijn operationele payload.
 *
 * @returns {express.Router}
 */
module.exports = function createHealthRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  return router;
};
