'use strict';

const express = require('express');

/**
 * v11.2.4 · Phase 5.4a: User-settings routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createUserRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/user/settings — huidige user settings (of defaults)
 *   - PUT /api/user/settings — update settings (allowlist) + reschedule admin scans
 *
 * Allowed settings keys: startBankroll, unitEur, language, timezone, scanTimes,
 * scanEnabled, twoFactorEnabled, preferredBookies. Andere keys worden genegeerd.
 *
 * @param {object} deps
 *   - loadUsers            — async (bypassCache?) → array
 *   - saveUser             — async (user) → void
 *   - defaultSettings      — fn () → object
 *   - rescheduleUserScans  — fn (user) → void (herplan admin cron-scans)
 * @returns {express.Router}
 */
module.exports = function createUserRouter(deps) {
  const { loadUsers, saveUser, defaultSettings, rescheduleUserScans } = deps;

  const required = { loadUsers, saveUser, defaultSettings, rescheduleUserScans };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createUserRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/user/settings', async (req, res) => {
    try {
      const users = await loadUsers();
      const user  = users.find(u => u.id === req.user.id);
      res.json(user?.settings || defaultSettings());
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.put('/user/settings', async (req, res) => {
    try {
      const users = await loadUsers(true);
      const user  = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      // Allowlist: alleen deze keys mogen door user gemuteerd worden. Arbitrary
      // keys zoals `role`, `status`, `id` worden geweerd tegen privilege-escalatie.
      const allowed = ['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled','preferredBookies'];
      allowed.forEach(k => { if (req.body[k] !== undefined) user.settings[k] = req.body[k]; });
      await saveUser(user);
      // Herplan scans als admin
      if (user.role === 'admin') rescheduleUserScans(user);
      res.json({ settings: user.settings });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
