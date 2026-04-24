'use strict';

const express = require('express');

/**
 * v12.2.0 · Bookie-balance routes.
 *
 * Endpoints:
 *   - GET  /api/bookie-balances         — lijst balances + totaal + low-alerts
 *   - PUT  /api/bookie-balances/:bookie — set balance voor een bookie (init/correctie)
 *
 * Balance-wijzigingen door bets gaan via bet-flow hooks in lib/bets-data.js,
 * niet via deze endpoints.
 *
 * @param {object} deps
 *   - bookieBalanceStore: createBookieBalanceStore instantie
 *   - rateLimit:          fn(key, max, ms) → boolean
 */
module.exports = function createBookieBalancesRouter(deps) {
  const { bookieBalanceStore, rateLimit } = deps;
  if (!bookieBalanceStore) throw new Error('createBookieBalancesRouter: missing bookieBalanceStore');
  if (!rateLimit) throw new Error('createBookieBalancesRouter: missing rateLimit');

  const router = express.Router();

  router.get('/bookie-balances', async (req, res) => {
    try {
      const userId = req.user?.id || null;
      const list = await bookieBalanceStore.listBalances(userId);
      const total = +list.reduce((s, r) => s + r.balance, 0).toFixed(2);
      const low = await bookieBalanceStore.lowBalances(userId);
      res.json({ balances: list, total, lowAlerts: low });
    } catch (e) {
      console.error('[bookie-balances] GET error:', e.message);
      res.status(500).json({ error: 'Interne fout' });
    }
  });

  router.put('/bookie-balances/:bookie', async (req, res) => {
    try {
      const userId = req.user?.id || null;
      if (rateLimit('bookiebal:' + userId, 30, 60 * 1000)) {
        return res.status(429).json({ error: 'Te veel updates · wacht een minuut' });
      }
      const bookie = String(req.params.bookie || '').trim();
      if (!bookie) return res.status(400).json({ error: 'Bookie naam vereist' });
      const raw = req.body?.balance;
      const balance = typeof raw === 'number' ? raw : parseFloat(raw);
      if (!Number.isFinite(balance)) return res.status(400).json({ error: 'Ongeldige balance' });
      const result = await bookieBalanceStore.setBalance(userId, bookie, balance);
      res.json(result);
    } catch (e) {
      console.error('[bookie-balances] PUT error:', e.message);
      res.status(500).json({ error: 'Interne fout' });
    }
  });

  return router;
};
