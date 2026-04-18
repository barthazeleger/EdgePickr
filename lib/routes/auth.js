'use strict';

const express = require('express');
const crypto = require('crypto');

/**
 * v11.2.3 · Phase 5.3: Auth + password routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAuthRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - POST /api/auth/login       — email+password → token (of 2FA challenge)
 *   - POST /api/auth/verify-code — 2FA code → token
 *   - POST /api/auth/register    — nieuwe user (status=pending)
 *   - GET  /api/auth/me          — huidige user (via req.user)
 *   - PUT  /api/auth/password    — change password
 *
 * @param {object} deps
 *   - rateLimit          — fn (key, maxCount, windowMs) → boolean (true = over limit)
 *   - loadUsers          — async (bypassCache?) → array
 *   - saveUser           — async (user) → void
 *   - bcrypt             — bcrypt / bcryptjs module
 *   - jwt                — jsonwebtoken module
 *   - jwtSecret          — string (JWT signing secret)
 *   - loginCodes         — Map (email → {code, expiresAt}) voor 2FA state
 *   - sendEmail          — async (to, subject, html) → boolean
 *   - notify             — async (msg) → void (voor registratie-alert)
 *   - defaultSettings    — fn () → object (default settings voor nieuwe user)
 * @returns {express.Router}
 */
module.exports = function createAuthRouter(deps) {
  const {
    rateLimit,
    loadUsers,
    saveUser,
    bcrypt,
    jwt,
    jwtSecret,
    loginCodes,
    sendEmail,
    notify,
    defaultSettings,
  } = deps;

  const required = { rateLimit, loadUsers, saveUser, bcrypt, jwt, jwtSecret, loginCodes, sendEmail, notify, defaultSettings };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAuthRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.post('/auth/login', async (req, res) => {
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
      // v10.12.1 (security): composite IP+email key. Voorkomt dat één attacker-IP
      // alle login-buckets uitput + zorgt dat shared-NAT users (kantoor) niet
      // elkaar DoS'en.
      const emailKey = String(email).toLowerCase();
      if (rateLimit('login:' + ip + ':' + emailKey, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Te veel pogingen · probeer over 15 minuten opnieuw' });
      const users = await loadUsers();
      const user  = users.find(u => u.email === email.toLowerCase());
      if (!user)                        return res.status(401).json({ error: 'E-mail of wachtwoord onjuist' });
      if (user.status === 'blocked')    return res.status(403).json({ error: 'Account geblokkeerd · neem contact op' });
      if (user.status === 'pending')    return res.status(403).json({ error: 'Je account wacht nog op goedkeuring. Check je email.' });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'E-mail of wachtwoord onjuist' });
      // 2FA: if enabled, send code via email instead of token
      if (user.settings?.twoFactorEnabled) {
        const code = String(crypto.randomInt(100000, 999999));
        loginCodes.set(user.email, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
        const sent = await sendEmail(user.email, 'EdgePickr login code', `<h2>Je login code: ${code}</h2><p>Geldig voor 5 minuten.</p>`);
        if (!sent) {
          loginCodes.delete(user.email);
          return res.status(500).json({ error: 'Kon verificatie-email niet verzenden. Probeer later opnieuw.' });
        }
        return res.json({ requires2FA: true });
      }
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: '30d' });
      res.json({ token, user: { id: user.id, email: user.email, role: user.role, settings: user.settings } });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.post('/auth/verify-code', async (req, res) => {
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const { email, code } = req.body || {};
      if (!email || !code) return res.status(400).json({ error: 'E-mail en code verplicht' });
      const emailKey = String(email).toLowerCase();
      if (rateLimit('verify2fa:' + ip + ':' + emailKey, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Te veel pogingen · probeer over 15 minuten opnieuw' });
      const entry = loginCodes.get(emailKey);
      // v10.12.1 (security): constant-time compare op 2FA code.
      const codeMatch = (() => {
        if (!entry) return false;
        const a = Buffer.from(String(entry.code));
        const b = Buffer.from(String(code));
        if (a.length !== b.length) return false;
        try { return crypto.timingSafeEqual(a, b); } catch { return false; }
      })();
      if (!entry || !codeMatch || Date.now() > entry.expiresAt) {
        return res.status(401).json({ error: 'Ongeldige of verlopen code' });
      }
      loginCodes.delete(email.toLowerCase());
      const users = await loadUsers();
      const user = users.find(u => u.email === email.toLowerCase());
      if (!user) return res.status(401).json({ error: 'Verificatie mislukt' });
      // Herhaal status-check: account kan tussen code-uitgifte en verify geblokkeerd of niet-goedgekeurd zijn
      if (user.status === 'blocked') return res.status(403).json({ error: 'Account geblokkeerd · neem contact op' });
      if (user.status === 'pending') return res.status(403).json({ error: 'Je account wacht nog op goedkeuring. Check je email.' });
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret, { expiresIn: '30d' });
      res.json({ token, user: { id: user.id, email: user.email, role: user.role, settings: user.settings } });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.post('/auth/register', async (req, res) => {
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const emailKey = req.body?.email ? String(req.body.email).toLowerCase() : 'unknown';
      if (rateLimit('register:' + ip + ':' + emailKey, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Te veel registraties · probeer over een uur' });
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
      if (password.length < 8)  return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });
      const users = await loadUsers(true);
      if (users.find(u => u.email === email.toLowerCase()))
        return res.status(200).json({ message: 'Registratie ontvangen. Je krijgt een email zodra je account is goedgekeurd.' }); // generic to prevent enumeration
      const hash = await bcrypt.hash(password, 10);
      await saveUser({
        id: crypto.randomUUID(), email: email.toLowerCase(), passwordHash: hash,
        role: 'user', status: 'pending',
        settings: defaultSettings(), createdAt: new Date().toISOString()
      });
      notify(`🆕 Nieuwe registratie: ${email}\nGoedkeuren via Admin-panel`).catch(() => {});
      res.json({ message: 'Registratie ontvangen. Je krijgt een email zodra je account is goedgekeurd.' });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/auth/me', async (req, res) => {
    try {
      const users = await loadUsers();
      const user  = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      res.json({ id: user.id, email: user.email, role: user.role, settings: user.settings });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.put('/auth/password', async (req, res) => {
    try {
      // v10.12.1 (security): rate-limit per user-id. Bcrypt-10 hash is ~100ms;
      // zonder limit kan een auth'd client de CPU verzadigen met loop-change.
      if (rateLimit('passwd:' + req.user?.id, 5, 60 * 1000)) return res.status(429).json({ error: 'Te veel pogingen · wacht een minuut' });
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Huidig en nieuw wachtwoord verplicht' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'Nieuw wachtwoord minimaal 8 tekens' });
      const users = await loadUsers(true);
      const user  = users.find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Huidig wachtwoord onjuist' });
      user.passwordHash = await bcrypt.hash(newPassword, 10);
      await saveUser(user);
      res.json({ message: 'Wachtwoord gewijzigd' });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
