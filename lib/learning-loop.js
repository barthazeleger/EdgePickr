'use strict';

const { normalizeSport, detectMarket, epBucketKey } = require('./model-math');

const DEFAULT_EPW = { '0.28':0.80, '0.30':0.95, '0.38':1.05, '0.45':1.15, '0.55':1.25 };

/**
 * v11.3.22 · Phase 6.4: Learning-loop core (updateCalibration + revertCalibration)
 * extracted uit server.js. De canonieke writers die `calib.markets`, `calib.leagues`,
 * `calib.epBuckets`, `calib.totalSettled/Wins/Profit`, `calib.lossLog` en
 * `calib.modelLog` muteren bij een bet-settle of outcome-flip.
 *
 * Factory pattern. Gebruik:
 *   const ll = createLearningLoop({ loadCalib, saveCalib, getUsersCache, notify, getUserMoneySettings });
 *   await ll.updateCalibration(bet, userId);
 *   await ll.revertCalibration(prevBet, userId);
 *
 * Principes:
 *   - Alleen admin-bets mogen de learning-loop voeden (non-admin bets skipped).
 *   - Multiplier-herberekening na ≥8 bets per markt-key (floor 0.55, cap 1.30).
 *   - EP-bucket weight recalibration vanaf 100 totaal + 15 per bucket.
 *   - Revert = mirror van update met `Math.max(0, n-1)` floors. Geen modelLog-edit
 *     (audit-trail blijft; multiplier zelf herkalibreert bij volgende update).
 *
 * @param {object} deps
 *   - loadCalib              — fn () → calib
 *   - saveCalib              — async (calib) → void
 *   - getUsersCache          — fn () → users[]
 *   - notify                 — async (text, type?, userId?) → void
 *   - getUserMoneySettings   — async (userId) → { unitEur, startBankroll }
 * @returns {{ updateCalibration, revertCalibration }}
 */
module.exports = function createLearningLoop(deps) {
  const { loadCalib, saveCalib, getUsersCache, notify, getUserMoneySettings } = deps;

  const required = { loadCalib, saveCalib, getUsersCache, notify, getUserMoneySettings };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createLearningLoop: missing required dep '${key}'`);
    }
  }

  async function updateCalibration(bet, userId = null) {
    if (!bet || !['W','L'].includes(bet.uitkomst)) return;
    if (userId) {
      const users = getUsersCache() || [];
      const user = users.find(u => u.id === userId);
      if (user && user.role !== 'admin') return;
    }
    const c    = loadCalib();
    const mKey = `${normalizeSport(bet.sport)}_${detectMarket(bet.markt || '')}`;
    const lg   = bet.wedstrijd?.split(' vs ')?.[0] ? (bet.league || 'Unknown') : 'Unknown';
    const won  = bet.uitkomst === 'W';
    const pnl  = parseFloat(bet.wl) || 0;

    c.totalSettled++; if (won) c.totalWins++; c.totalProfit += pnl;

    const mk = c.markets[mKey] || { n:0, w:0, profit:0, multiplier:1.0 };
    mk.n++; if (won) mk.w++; mk.profit += pnl;

    const oldMult = mk.multiplier;
    if (mk.n >= 8) {
      const wr = mk.w / mk.n;
      const profitPerBet = mk.profit / mk.n;
      if (profitPerBet < -3 && wr < 0.40) mk.multiplier = Math.max(0.55, mk.multiplier - 0.05);
      else if (profitPerBet > 3 && wr > 0.55) mk.multiplier = Math.min(1.30, mk.multiplier + 0.03);
      else mk.multiplier = Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0));
    }
    c.markets[mKey] = mk;

    const multDelta = Math.abs(mk.multiplier - oldMult);
    if (mk.n >= 8 && multDelta >= 0.04) {
      const dir    = mk.multiplier > oldMult ? '↑ vertrouwen omhoog' : '↓ drempel verhoogd';
      const wr     = mk.w / mk.n;
      const entry  = {
        date:    new Date().toISOString(),
        type:    'market_calibration',
        market:  mKey,
        oldMult: +oldMult.toFixed(3),
        newMult: +mk.multiplier.toFixed(3),
        n:       mk.n,
        winRate: +(wr * 100).toFixed(1),
        note:    `${mKey} · ${dir} (${wr*100 < 50 ? '' : '+'}${((wr-0.5)*100).toFixed(0)}% winrate, ${mk.n} bets)`,
      };
      c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
      c.modelLastUpdated = entry.date;
      notify(`🧠 MODEL UPDATE\n📊 ${mKey} multiplier: ${oldMult.toFixed(2)} → ${mk.multiplier.toFixed(2)}\n📈 Win rate: ${(wr*100).toFixed(0)}% (${mk.n} bets)\n${dir}`).catch(() => {});
    }

    const epEst = bet.ep ? parseFloat(bet.ep) : (bet.prob ? parseFloat(bet.prob) / 100 : null);
    if (epEst && epEst >= 0.28) {
      const bk = epBucketKey(epEst);
      if (!c.epBuckets) c.epBuckets = {};
      if (!c.epBuckets[bk]) c.epBuckets[bk] = { n:0, w:0, weight: DEFAULT_EPW[bk] };
      const eb = c.epBuckets[bk];
      eb.n++; if (won) eb.w++;

      if (c.totalSettled >= 100 && eb.n >= 15) {
        const actualWr  = eb.w / eb.n;
        const expectedWr = parseFloat(bk);
        const ratio     = actualWr / Math.max(expectedWr, 0.01);
        const oldW      = eb.weight;
        const rawNew    = oldW * (0.85 + ratio * 0.15);
        eb.weight       = Math.max(0.50, Math.min(1.60, +rawNew.toFixed(3)));

        if (Math.abs(eb.weight - oldW) >= 0.05) {
          const dir = eb.weight > oldW ? '↑' : '↓';
          const entry = {
            date:    new Date().toISOString(),
            type:    'ep_calibration',
            market:  `epW bucket ${bk}`,
            oldMult: +oldW.toFixed(3),
            newMult: +eb.weight.toFixed(3),
            n:       eb.n,
            winRate: +(actualWr*100).toFixed(1),
            note:    `epW [${bk}+] ${dir} bijgesteld · werkelijke hitrate ${(actualWr*100).toFixed(0)}% vs verwacht ${(expectedWr*100).toFixed(0)}% (${eb.n} bets)`,
          };
          c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
          c.modelLastUpdated = entry.date;
          notify(`🧠 MODEL UPDATE\n🎯 EP bucket [${bk}+] gewicht: ${oldW.toFixed(2)} → ${eb.weight.toFixed(2)}\n📈 Hit rate: ${(actualWr*100).toFixed(0)}% vs verwacht ${(expectedWr*100).toFixed(0)}% (${eb.n} bets)`).catch(() => {});
        }
      }
      c.epBuckets[bk] = eb;
    }

    if (!c.leagues[lg]) c.leagues[lg] = { n:0, w:0, profit:0 };
    c.leagues[lg].n++; if (won) c.leagues[lg].w++;
    c.leagues[lg].profit += pnl;

    if (!won) {
      c.lossLog = [
        { date: bet.datum, match: bet.wedstrijd, markt: bet.markt, odds: bet.odds,
          market: mKey, reason: '—', pnl },
        ...(c.lossLog || [])
      ].slice(0, 50);
    }

    c.lastUpdated = new Date().toISOString();

    const milestones = [10, 25, 50, 100, 200];
    if (milestones.includes(c.totalSettled)) {
      const money = await getUserMoneySettings(userId);
      const roi = c.totalProfit / Math.max(1, c.totalSettled * money.unitEur) * 100;
      const wr = c.totalWins / c.totalSettled * 100;
      const entry = {
        date: new Date().toISOString(), type: 'milestone',
        note: `🏆 ${c.totalSettled} bets milestone! Win rate: ${wr.toFixed(0)}% · ROI: ${roi.toFixed(1)}% · P/L: €${c.totalProfit.toFixed(2)}`
      };
      c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
      let msg = `🏆 MILESTONE: ${c.totalSettled} BETS\n📊 Win rate: ${wr.toFixed(0)}%\n💰 ROI: ${roi.toFixed(1)}%\n💵 P/L: €${c.totalProfit.toFixed(2)}`;
      if (c.totalSettled === 50 && roi > 10) {
        msg += `\n\n✅ ROI > 10% na 50 bets · overweeg unit verhoging naar €${Math.round(money.unitEur * 1.5)}`;
      } else if (c.totalSettled === 50 && roi < 0) {
        msg += `\n\n⚠️ Negatieve ROI · model review aanbevolen. Check signal attribution.`;
      }
      notify(msg).catch(() => {});
    }

    saveCalib(c);
    return c;
  }

  async function revertCalibration(bet, userId = null) {
    if (!bet || !['W','L'].includes(bet.uitkomst)) return;
    if (userId) {
      const users = getUsersCache() || [];
      const user = users.find(u => u.id === userId);
      if (user && user.role !== 'admin') return;
    }
    const c = loadCalib();
    const mKey = `${normalizeSport(bet.sport)}_${detectMarket(bet.markt || '')}`;
    const lg = bet.league || 'Unknown';
    const won = bet.uitkomst === 'W';
    const pnl = parseFloat(bet.wl) || 0;

    c.totalSettled = Math.max(0, (c.totalSettled || 0) - 1);
    if (won) c.totalWins = Math.max(0, (c.totalWins || 0) - 1);
    c.totalProfit = (c.totalProfit || 0) - pnl;

    const mk = c.markets?.[mKey];
    if (mk) {
      mk.n = Math.max(0, (mk.n || 0) - 1);
      if (won) mk.w = Math.max(0, (mk.w || 0) - 1);
      mk.profit = (mk.profit || 0) - pnl;
      c.markets[mKey] = mk;
    }

    const epEst = bet.ep ? parseFloat(bet.ep) : (bet.prob ? parseFloat(bet.prob) / 100 : null);
    if (epEst && epEst >= 0.28 && c.epBuckets) {
      const bk = epBucketKey(epEst);
      const eb = c.epBuckets[bk];
      if (eb) {
        eb.n = Math.max(0, (eb.n || 0) - 1);
        if (won) eb.w = Math.max(0, (eb.w || 0) - 1);
        c.epBuckets[bk] = eb;
      }
    }

    if (c.leagues?.[lg]) {
      c.leagues[lg].n = Math.max(0, (c.leagues[lg].n || 0) - 1);
      if (won) c.leagues[lg].w = Math.max(0, (c.leagues[lg].w || 0) - 1);
      c.leagues[lg].profit = (c.leagues[lg].profit || 0) - pnl;
    }

    c.lastUpdated = new Date().toISOString();
    saveCalib(c);
    return c;
  }

  return { updateCalibration, revertCalibration };
};

module.exports.DEFAULT_EPW = DEFAULT_EPW;
