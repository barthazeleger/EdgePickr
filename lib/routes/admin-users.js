'use strict';

const express = require('express');

/**
 * v11.2.5 · Phase 5.4c: Admin-user-management routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminUsersRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET    /api/admin/users      — lijst users (id, email, role, status, createdAt)
 *   - PUT    /api/admin/users/:id  — wijzig role/status; bij status=approved → notify+email
 *   - DELETE /api/admin/users/:id  — verwijder user (self-delete beschermd)
 *
 * @param {object} deps
 *   - supabase          — Supabase client (voor delete query)
 *   - requireAdmin      — Express middleware
 *   - loadUsers         — async (bypassCache?) → array
 *   - saveUser          — async (user) → void
 *   - clearUsersCache   — fn () → void (cache-invalidatie na delete)
 *   - notify            — async (msg) → void (push bij approve)
 *   - sendEmail         — async (to, subject, html) → boolean
 * @returns {express.Router}
 */
module.exports = function createAdminUsersRouter(deps) {
  const { supabase, requireAdmin, loadUsers, saveUser, clearUsersCache, notify, sendEmail } = deps;

  const required = { supabase, requireAdmin, loadUsers, saveUser, clearUsersCache, notify, sendEmail };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminUsersRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/admin/users', requireAdmin, async (req, res) => {
    try {
      const users = await loadUsers(true);
      res.json(users.map(u => ({ id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt })));
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.put('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const users = await loadUsers(true);
      const user  = users.find(u => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      const VALID_STATUSES = new Set(['pending', 'approved', 'blocked']);
      const VALID_ROLES = new Set(['user', 'admin']);
      if (req.body.status && !VALID_STATUSES.has(req.body.status)) return res.status(400).json({ error: 'Ongeldige status' });
      if (req.body.role && !VALID_ROLES.has(req.body.role)) return res.status(400).json({ error: 'Ongeldige rol' });
      if (req.body.status) user.status = req.body.status;
      if (req.body.role)   user.role   = req.body.role;
      await saveUser(user);
      if (req.body.status === 'approved') {
        notify(`✅ Account goedgekeurd: ${user.email}`).catch(() => {});
        sendEmail(user.email, 'Je EdgePickr account is goedgekeurd!',
          '<h2>Hey!</h2><p>Je account is goedgekeurd. Je kunt nu inloggen op <a href="https://edgepickr.com">https://edgepickr.com</a></p>'
        ).catch(() => {});
      }
      res.json({ id: user.id, email: user.email, role: user.role, status: user.status });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const users = await loadUsers(true);
      const user  = users.find(u => u.id === req.params.id);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      if (user.email === req.user.email)
        return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
      await supabase.from('users').delete().eq('id', req.params.id);
      clearUsersCache();
      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
