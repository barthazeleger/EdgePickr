'use strict';

const express = require('express');

/**
 * v11.2.0 · Phase 5.1: Notifications + Push routes extracted uit server.js.
 *
 * Factory pattern: elke deps is expliciet inject — geen globals of side-effects.
 * Mount via: `app.use('/api', createNotificationsRouter({ supabase, ... }))`.
 *
 * Verantwoordelijkheden:
 *   - `/api/push/vapid-key` — public VAPID key voor browser subscribe
 *   - `/api/push/subscribe` (POST/DELETE) — push subscription CRUD
 *   - `/api/inbox-notifications` (GET/PUT/DELETE) — operator inbox feed
 *
 * Niet in scope: de `/api/notifications` endpoint (aggregate alert-feed met
 * vele cross-system deps) blijft in server.js tot een bredere refactor.
 *
 * @param {object} deps
 *   - supabase       — Supabase client
 *   - isValidUuid    — UUID-check helper voor req.user.id validatie
 *   - rateLimit      — rate-limit middleware wrapper
 *   - savePushSub    — async (sub, userId) → void
 *   - deletePushSub  — async (endpoint) → void
 *   - vapidPublicKey — string
 * @returns {express.Router}
 */
module.exports = function createNotificationsRouter(deps) {
  const {
    supabase,
    isValidUuid,
    rateLimit,
    savePushSub,
    deletePushSub,
    vapidPublicKey,
  } = deps;

  if (!supabase || !isValidUuid || !rateLimit || !savePushSub || !deletePushSub) {
    throw new Error('createNotificationsRouter: missing required deps');
  }

  const router = express.Router();

  // ── PUSH ────────────────────────────────────────────────────────────────────
  router.get('/push/vapid-key', (req, res) => {
    res.json({ publicKey: vapidPublicKey });
  });

  router.post('/push/subscribe', async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimit('push:' + ip, 10, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Te veel verzoeken' });
    }
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'Geen subscription' });
    await savePushSub(sub, req.user?.id || null);
    res.json({ ok: true });
  });

  router.delete('/push/subscribe', async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'Geen endpoint' });
    await deletePushSub(endpoint);
    res.json({ ok: true });
  });

  // ── INBOX ──────────────────────────────────────────────────────────────────
  router.get('/inbox-notifications', async (req, res) => {
    try {
      if (!isValidUuid(req.user?.id)) {
        return res.status(401).json({ error: 'Invalid user context' });
      }
      let query = supabase.from('notifications')
        .select('*').order('created_at', { ascending: false }).limit(50);
      // Filter: user's own notifications + global (null user_id)
      query = query.or(`user_id.eq.${req.user.id},user_id.is.null`);
      const { data, error } = await query;
      if (error) throw error;
      const unread = (data || []).filter(n => !n.read).length;
      res.json({ notifications: data || [], unread });
    } catch { res.status(500).json({ error: 'Interne fout' }); }
  });

  // v10.9.8: mark-as-read werkte ook op global rows (user_id=null) vanuit
  // iedere user → iemand kon "Overweeg API-upgrade" weg-marken voor iedereen.
  // Nu: global rows alleen door admin muteerbaar; users markeren alleen hun eigen.
  router.put('/inbox-notifications/read', async (req, res) => {
    try {
      if (!isValidUuid(req.user?.id)) return res.status(401).json({ error: 'Invalid user context' });
      const isAdmin = req.user?.role === 'admin';
      const scope = isAdmin
        ? `user_id.eq.${req.user.id},user_id.is.null`
        : `user_id.eq.${req.user.id}`;
      await supabase.from('notifications').update({ read: true })
        .eq('read', false).or(scope);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Interne fout' }); }
  });

  // v10.9.8: delete-all global rows alleen door admin — voorheen kon elke user
  // global notifications verwijderen voor iedereen.
  router.delete('/inbox-notifications', async (req, res) => {
    try {
      if (!isValidUuid(req.user?.id)) return res.status(401).json({ error: 'Invalid user context' });
      const isAdmin = req.user?.role === 'admin';
      const scope = isAdmin
        ? `user_id.eq.${req.user.id},user_id.is.null`
        : `user_id.eq.${req.user.id}`;
      await supabase.from('notifications').delete().or(scope);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
