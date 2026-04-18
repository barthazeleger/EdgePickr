'use strict';

const express = require('express');

/**
 * v11.3.15 · Phase 5.4w: Aggregate notifications/alert feed extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createNotificationsFeedRouter({...}))`.
 *
 * Let op: dit is de aggregate alert-feed. De inbox CRUD-routes (notifications read/
 * mark/delete) zitten in `lib/routes/notifications.js` (sinds v11.2.0).
 *
 * Endpoint:
 *   - GET /api/notifications — banner-alerts voor UI: bankroll milestones,
 *     All Sports upgrade trigger, loss-pattern warning, market-multiplier
 *     signals, model-update feed (14d window), tijdgebonden reminders (Bet365-
 *     limit), Supabase free-tier capacity alerts.
 *
 * @param {object} deps
 *   - supabase
 *   - loadCalib              — fn () → calib
 *   - getAdminUserId         — async () → string
 *   - getUserMoneySettings   — async (userId) → { unitEur, startBankroll }
 *   - readBets               — async (userId, money) → { bets, stats }
 *   - loadUsers              — async () → users[]
 * @returns {express.Router}
 */
module.exports = function createNotificationsFeedRouter(deps) {
  const { supabase, loadCalib, getAdminUserId, getUserMoneySettings, readBets, loadUsers } = deps;

  const required = { supabase, loadCalib, getAdminUserId, getUserMoneySettings, readBets, loadUsers };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createNotificationsFeedRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/notifications', async (req, res) => {
    try {
      const alerts = [];
      const c = loadCalib();

      const adminUserId = await getAdminUserId();
      const money = await getUserMoneySettings(adminUserId);
      const { stats } = await readBets(adminUserId, money).catch(() => ({ stats: {} }));
      const roi = stats.roi ?? 0;
      const bankroll = stats.bankroll ?? money.startBankroll;
      const bankrollGrowth = bankroll - money.startBankroll;

      if (bankrollGrowth >= money.startBankroll) {
        alerts.push({ type: 'success', icon: '💰', msg: `Bankroll +100% (€${bankroll.toFixed(0)}) · unit verhoging aanbevolen: €${money.unitEur} → €${money.unitEur*2}`, unitAdvice: true });
      } else if (bankrollGrowth >= money.startBankroll * 0.5) {
        alerts.push({ type: 'info', icon: '💰', msg: `Bankroll +50% (€${bankroll.toFixed(0)}) · overweeg unit van €${money.unitEur} naar €${Math.round(money.unitEur*1.5)}`, unitAdvice: true });
      }

      if (c.totalSettled >= 30 && roi > 0.10) {
        alerts.push({ type: 'success', icon: '🚀', msg: `ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets · api-sports All Sports ($99/mnd) betaalt zich terug.` });
      } else if (c.totalSettled >= 20 && roi > 0.05) {
        alerts.push({ type: 'info', icon: '💡', msg: `ROI ${(roi*100).toFixed(1)}% · winstgevend! Wacht tot 30+ bets voor All Sports upgrade.` });
      }

      if (c.lossLog?.length >= 5) {
        const byMarket = {};
        for (const l of c.lossLog.slice(0, 20)) byMarket[l.market] = (byMarket[l.market]||0) + 1;
        const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
        if (worst?.[1] >= 3) {
          alerts.push({ type: 'warn', icon: '⚠️', msg: `${worst[1]}x verlies in "${worst[0]}" picks (laatste 20 bets) · model drempel verhoogd.` });
        }
      }

      for (const [mk, v] of Object.entries(c.markets || {})) {
        if (v.n >= 8 && v.multiplier <= 0.75) {
          alerts.push({ type: 'warn', icon: '📉', msg: `"${mk}" picks: ${v.w}/${v.n} gewonnen · model filtert strenger.` });
        } else if (v.n >= 10 && v.multiplier >= 1.15) {
          alerts.push({ type: 'success', icon: '📈', msg: `"${mk}" picks presteren goed (${v.w}/${v.n}) · model vertrouwt dit signaal meer.` });
        }
      }

      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      for (const entry of (c.modelLog || []).slice(0, 3)) {
        if (new Date(entry.date).getTime() < cutoff) break;
        const hasMult = typeof entry.oldMult === 'number' && typeof entry.newMult === 'number';
        const dir = hasMult ? (entry.newMult > entry.oldMult ? '📈' : '📉') : '🧠';
        const msg = hasMult
          ? `Model update: ${entry.note} (${entry.oldMult.toFixed(2)}→${entry.newMult.toFixed(2)})`
          : `Model update: ${entry.note || entry.type || 'update'}`;
        alerts.push({
          type:        'model',
          icon:        dir,
          msg,
          date:        entry.date,
          modelUpdate: true,
        });
      }

      // TODO: remove after 2026-04-26 — one-shot Bet365-limit reminder
      try {
        const now = new Date();
        const start = new Date('2026-04-19T00:00:00+02:00');
        const expire = new Date('2026-04-26T00:00:00+02:00');
        if (now >= start && now < expire) {
          const users = await loadUsers();
          const user = users.find(u => u.id === req.user?.id);
          const prefs = user?.settings?.preferredBookies;
          const hasBet365 = Array.isArray(prefs) && prefs.some(b => (b || '').toLowerCase().includes('bet365'));
          if (!hasBet365) {
            alerts.push({
              type: 'info',
              icon: '🔓',
              msg: 'Bet365-limiet is afgelopen (19 apr). Zet Bet365 weer aan in Settings → preferred bookies.',
            });
          }
        }
      } catch {}

      try {
        const { count: betCount } = await supabase.from('bets').select('*', { count: 'exact', head: true });
        const { count: scanCount } = await supabase.from('scan_history').select('*', { count: 'exact', head: true });
        const estMB = ((betCount || 0) * 0.002 + (scanCount || 0) * 0.05).toFixed(1);
        if (parseFloat(estMB) > 400) {
          alerts.push({ type: 'error', icon: '🗄️', msg: `Supabase database bijna vol: ~${estMB}MB / 500MB · upgrade naar Pro ($25/mnd) aanbevolen.` });
        } else if (parseFloat(estMB) > 250) {
          alerts.push({ type: 'warn', icon: '🗄️', msg: `Supabase database: ~${estMB}MB / 500MB gebruikt. Nog ruimte maar hou in de gaten.` });
        }
      } catch {}

      res.json({ alerts, totalSettled: c.totalSettled, lastUpdated: c.lastUpdated, modelLastUpdated: c.modelLastUpdated || null });
    } catch (e) { res.status(500).json({ alerts: [], error: 'Interne fout' }); }
  });

  return router;
};
