'use strict';

const express = require('express');
const { computeProfitUnitsFromBet } = require('../learning-loop');

/**
 * v11.3.13 · Phase 5.4u: Admin rebuild-calib + backfill-signals extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminBackfillRouter({...}))`.
 *
 * Endpoints:
 *   - POST /api/admin/rebuild-calib     — rebuild c.markets/leagues vanaf 0 over admin settled bets,
 *                                         preserve oude multiplier als prior (of reset via body),
 *                                         cap op 10k bets (DoS-guard), mutex om races met scans.
 *   - POST /api/admin/backfill-signals  — retroactief signals vullen voor bets zonder, via fixture +
 *                                         pick_candidates join (zelfde bookie + odds binnen 3-5%).
 *                                         Max 500/call, rate-limit 100ms/bet, mutex.
 *
 * @param {object} deps
 *   - supabase
 *   - requireAdmin                — middleware
 *   - loadCalib                   — fn () → calib
 *   - saveCalib                   — async (calib) → void
 *   - getUsersCache               — fn () → users[]
 *   - normalizeSport              — fn (sport) → string
 *   - detectMarket                — fn (markt) → string
 *   - computeMarketMultiplier     — fn (stats, currentMultiplier) → number
 *   - refreshMarketSampleCounts   — async () → void
 *   - findGameId                  — async (sport, wedstrijd) → number | null
 * @returns {express.Router}
 */
module.exports = function createAdminBackfillRouter(deps) {
  const {
    supabase,
    requireAdmin,
    loadCalib,
    saveCalib,
    getUsersCache,
    normalizeSport,
    detectMarket,
    computeMarketMultiplier,
    refreshMarketSampleCounts,
    findGameId,
  } = deps;

  const required = {
    supabase, requireAdmin, loadCalib, saveCalib, getUsersCache,
    normalizeSport, detectMarket, computeMarketMultiplier,
    refreshMarketSampleCounts, findGameId,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminBackfillRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  let _calibRebuildInProgress = false;

  router.post('/admin/rebuild-calib', requireAdmin, async (req, res) => {
    if (_calibRebuildInProgress) return res.status(409).json({ error: 'Rebuild al lopende, probeer over 30s opnieuw' });
    _calibRebuildInProgress = true;
    try {
      const dryRun = req.body?.dryRun === true;
      const resetMultipliers = req.body?.resetMultipliers === true;
      const QUERY_CEILING = 10000;

      const users = getUsersCache() || [];
      const adminIds = users.filter(u => u.role === 'admin').map(u => u.id);
      let q = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']).limit(QUERY_CEILING);
      if (adminIds.length) q = q.in('user_id', adminIds);
      const { data: bets, error } = await q;
      if (error) { console.error('[admin-backfill]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }

      const oldC = loadCalib();
      const oldMarkets = oldC.markets || {};

      const newMarkets = {};
      const newLeagues = {};
      let totalSettled = 0, totalWins = 0, totalProfit = 0;
      for (const b of (bets || [])) {
        if (!['W','L'].includes(b.uitkomst)) continue;
        const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || '')}`;
        const won = b.uitkomst === 'W';
        const pnl = parseFloat(b.wl) || 0;
        if (!newMarkets[key]) {
          const priorMult = (!resetMultipliers && oldMarkets[key]?.multiplier) || 1.0;
          newMarkets[key] = { n: 0, w: 0, profit: 0, profitUnits: 0, staked: 0, multiplier: priorMult };
        }
        const mk = newMarkets[key];
        mk.n++; if (won) mk.w++; mk.profit += pnl;
        const stake = Number(b.inzet);
        if (Number.isFinite(stake) && stake > 0) mk.staked += stake;
        const profitUnits = computeProfitUnitsFromBet(b, pnl);
        if (Number.isFinite(profitUnits)) mk.profitUnits += profitUnits;
        totalSettled++; if (won) totalWins++; totalProfit += pnl;

        const lg = b.league || 'Unknown';
        if (!newLeagues[lg]) newLeagues[lg] = { n: 0, w: 0, profit: 0 };
        newLeagues[lg].n++; if (won) newLeagues[lg].w++; newLeagues[lg].profit += pnl;
      }

      for (const mk of Object.values(newMarkets)) {
        const prior = mk.multiplier;
        mk.multiplier = computeMarketMultiplier(mk, prior);
      }

      const perSportMap = {};
      for (const [k, mk] of Object.entries(newMarkets)) {
        const sp = k.split('_')[0] || 'football';
        if (!perSportMap[sp]) perSportMap[sp] = { n: 0, w: 0, profit: 0 };
        perSportMap[sp].n += mk.n; perSportMap[sp].w += mk.w; perSportMap[sp].profit += mk.profit;
      }

      const before = Object.fromEntries(Object.entries(oldMarkets).map(([k, v]) => [k, v.n]));
      const after = Object.fromEntries(Object.entries(newMarkets).map(([k, v]) => [k, v.n]));
      const diff = {};
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const k of keys) diff[k] = { before: before[k] || 0, after: after[k] || 0 };

      if (!dryRun) {
        const next = { ...oldC, markets: newMarkets, leagues: newLeagues,
                       totalSettled, totalWins, totalProfit,
                       modelLastUpdated: new Date().toISOString() };
        await saveCalib(next);
        refreshMarketSampleCounts().catch(e => console.error('refreshMarketSampleCounts na rebuild:', e.message));
      }
      res.json({ ok: true, dryRun, resetMultipliers, totalSettled, totalWins, totalProfit,
        perSport: perSportMap, marketDiff: diff, newMarketKeys: Object.keys(newMarkets).sort(),
        leaguesCount: Object.keys(newLeagues).length,
        capped: (bets?.length || 0) >= QUERY_CEILING });
    } catch (e) {
      // v11.3.23 H3: no raw e.message to client.
      console.error('[rebuild-calib]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    } finally {
      _calibRebuildInProgress = false;
    }
  });

  let _backfillSignalsInProgress = false;

  router.post('/admin/backfill-signals', requireAdmin, async (req, res) => {
    if (_backfillSignalsInProgress) return res.status(409).json({ error: 'Backfill al lopende, probeer over een minuut opnieuw' });
    _backfillSignalsInProgress = true;
    try {
      const dryRun = req.body?.dryRun === true;
      const MAX_CANDIDATES = Math.min(parseInt(req.body?.max || 500), 1000);
      const { data: bets, error: betsErr } = await supabase.from('bets')
        .select('*').limit(5000);
      if (betsErr) return res.status(500).json({ error: betsErr.message });

      const candidates = (bets || []).filter(b => {
        if (b.signals == null) return true;
        if (typeof b.signals === 'string') return b.signals === '' || b.signals === '[]';
        if (Array.isArray(b.signals)) return b.signals.length === 0;
        return false;
      }).slice(0, MAX_CANDIDATES);

      const results = { scanned: candidates.length, matched: 0, updated: 0, failed: 0, details: [], capped: candidates.length === MAX_CANDIDATES };

      for (const b of candidates) {
        try {
          let fxId = b.fixture_id;
          if (!fxId) {
            const sport = b.sport || 'football';
            try {
              fxId = await findGameId(sport, b.wedstrijd);
              if (fxId && !dryRun) {
                await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', b.bet_id);
              }
            } catch {}
          }
          if (!fxId) { results.failed++; results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'fixture niet gevonden' }); continue; }

          const { data: cands } = await supabase.from('pick_candidates')
            .select('signals, bookmaker, bookmaker_odds, selection_key')
            .eq('fixture_id', fxId);
          if (!cands || !cands.length) { results.failed++; results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'geen pick_candidates' }); continue; }

          const betOdds = parseFloat(b.odds) || 0;
          const betBookie = (b.tip || '').toLowerCase();
          const match = cands.find(c => {
            const oddsDiff = Math.abs(parseFloat(c.bookmaker_odds || 0) - betOdds) / Math.max(betOdds, 0.01);
            return oddsDiff < 0.03 && (c.bookmaker || '').toLowerCase().includes(betBookie);
          }) || cands.find(c => {
            const oddsDiff = Math.abs(parseFloat(c.bookmaker_odds || 0) - betOdds) / Math.max(betOdds, 0.01);
            return oddsDiff < 0.05;
          });

          if (!match || !Array.isArray(match.signals) || !match.signals.length) {
            results.failed++;
            results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'geen matchende candidate met signals' });
            continue;
          }
          results.matched++;
          if (!dryRun) {
            await supabase.from('bets').update({ signals: match.signals }).eq('bet_id', b.bet_id);
            results.updated++;
          }
          results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, signalsCount: match.signals.length, action: dryRun ? 'would-update' : 'updated' });
        } catch (e) {
          results.failed++;
          results.details.push({ id: b.bet_id, reason: (e && e.message) || String(e) || 'unknown' });
        }
        await new Promise(rs => setTimeout(rs, 100));
      }

      res.json({ ok: true, dryRun, ...results });
    } catch (e) {
      // v11.3.23 H3: no raw e.message to client.
      console.error('[backfill-signals]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    } finally {
      _backfillSignalsInProgress = false;
    }
  });

  return router;
};
