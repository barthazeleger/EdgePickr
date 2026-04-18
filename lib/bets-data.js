'use strict';

/**
 * v11.3.21 · Phase 6.3: Data-access laag voor de `bets` Supabase-tabel
 * extracted uit server.js. Pure data-toegang + stats-berekening.
 *
 * Factory pattern. Gebruik:
 *   const bd = createBetsData({ supabase, getUserMoneySettings, revertCalibration, updateCalibration, ... });
 *   const { bets, stats } = await bd.readBets(userId);
 *
 * Verantwoordelijkheden:
 *   - calcStats         — pure aggregaties (W/L, ROI, CLV, variance, potentiële winst/verlies vandaag).
 *   - readBets          — leest bets uit Supabase, projecteert naar app-vorm, berekent stats.
 *   - getUserUnitEur    — thin wrapper om unitEur op te halen voor writes.
 *   - writeBet          — inserts nieuwe bet met schema-tolerant tier-retry (v10.10.7 → legacy).
 *   - updateBetOutcome  — update uitkomst + wl, trigger revert+apply calibration bij flip.
 *   - deleteBet         — verwijder bet uit Supabase (user-scoped).
 *
 * @param {object} deps
 *   - supabase
 *   - getUserMoneySettings — async (userId) → { startBankroll, unitEur }
 *   - defaultStartBankroll — number fallback voor calcStats
 *   - defaultUnitEur       — number fallback voor calcStats
 *   - revertCalibration    — async (bet, userId) → void (voor outcome-flip)
 *   - updateCalibration    — async (bet, userId) → void (voor nieuwe settled)
 * @returns {object}
 */
module.exports = function createBetsData(deps) {
  const {
    supabase,
    getUserMoneySettings,
    defaultStartBankroll,
    defaultUnitEur,
    revertCalibration,
    updateCalibration,
  } = deps;

  const required = {
    supabase, getUserMoneySettings,
    revertCalibration, updateCalibration,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createBetsData: missing required dep '${key}'`);
    }
  }

  function calcStats(bets, startBankroll = defaultStartBankroll, unitEur = defaultUnitEur) {
    const W     = bets.filter(b => b.uitkomst === 'W').length;
    const L     = bets.filter(b => b.uitkomst === 'L').length;
    const open  = bets.filter(b => b.uitkomst === 'Open').length;
    const total = bets.length;
    const wlEur = bets.reduce((s, b) => s + (b.uitkomst !== 'Open' ? b.wl : 0), 0);
    const totalInzet = bets.filter(b => b.uitkomst !== 'Open').reduce((s, b) => s + b.inzet, 0);
    const roi   = totalInzet > 0 ? wlEur / totalInzet : 0;
    const bankroll  = +(startBankroll + wlEur).toFixed(2);
    const avgOdds   = total > 0 ? +(bets.reduce((s,b)=>s+b.odds,0)/total).toFixed(3) : 0;
    const avgUnits  = total > 0 ? +(bets.reduce((s,b)=>s+b.units,0)/total).toFixed(2) : 0;
    const strikeRate = (W+L) > 0 ? Math.round(W/(W+L)*100) : 0;
    const unitFor = (b) => {
      const ue = b && b.unitAtTime;
      return Number.isFinite(ue) && ue > 0 ? ue : unitEur;
    };
    const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
    const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
    const clvBets = bets.filter(b => b.clvPct !== null && b.clvPct !== undefined && !isNaN(b.clvPct));
    const avgCLV = clvBets.length > 0 ? +(clvBets.reduce((s, b) => s + b.clvPct, 0) / clvBets.length).toFixed(2) : 0;
    const clvPositive = clvBets.filter(b => b.clvPct > 0).length;
    const clvTotal = clvBets.length;

    const settledBets = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    const expectedWins = +settledBets.reduce((s, b) => {
      const prob = b.odds > 1 ? 1 / b.odds : 0.5;
      return s + prob;
    }, 0).toFixed(2);
    const actualWins = W;
    const variance = +(actualWins - expectedWins).toFixed(2);
    const varianceStdDev = +Math.sqrt(settledBets.reduce((s, b) => {
      const prob = b.odds > 1 ? 1 / b.odds : 0.5;
      return s + prob * (1 - prob);
    }, 0)).toFixed(2);
    const luckFactor = varianceStdDev > 0 ? +(variance / varianceStdDev).toFixed(2) : 0;

    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const todayBets = bets.filter(b => {
      if (b.uitkomst !== 'Open') return false;
      const d = b.datum;
      if (!d) return false;
      const parts = d.split('-');
      if (parts.length !== 3) return false;
      const iso = `${parts[2]}-${parts[1]}-${parts[0]}`;
      return iso === todayStr;
    });
    const potentialWin = +todayBets.reduce((s, b) => s + (b.odds - 1) * b.inzet, 0).toFixed(2);
    const potentialLoss = +todayBets.reduce((s, b) => s + b.inzet, 0).toFixed(2);
    const todayBetsCount = todayBets.length;

    const netUnits  = +bets.reduce((s, b) => {
      if (b.uitkomst === 'Open') return s;
      const ue = unitFor(b);
      return ue > 0 ? s + (b.wl / ue) : s;
    }, 0).toFixed(2);
    const netProfit = +wlEur.toFixed(2);

    return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
             bankroll, startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU,
             netUnits, netProfit,
             avgCLV, clvPositive, clvTotal,
             expectedWins, actualWins, variance, varianceStdDev, luckFactor,
             potentialWin, potentialLoss, todayBetsCount };
  }

  async function readBets(userId = null, money = null) {
    const effectiveMoney = money || await getUserMoneySettings(userId);
    let query = supabase.from('bets').select('*').order('bet_id', { ascending: true });
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const bets = (data || []).map(r => {
      const unitAtTime = Number.isFinite(parseFloat(r.unit_at_time)) && parseFloat(r.unit_at_time) > 0
        ? parseFloat(r.unit_at_time)
        : null;
      const ueForInzet = unitAtTime || effectiveMoney.unitEur;
      return {
        id: r.bet_id, datum: r.datum || '', sport: r.sport || '', wedstrijd: r.wedstrijd || '',
        markt: r.markt || '', odds: r.odds || 0, units: r.units || 0,
        inzet: r.inzet != null ? r.inzet : +(r.units * ueForInzet).toFixed(2),
        tip: r.tip || 'Bet365', uitkomst: r.uitkomst || 'Open', wl: r.wl || 0,
        tijd: r.tijd || '', score: r.score || null,
        signals: r.signals || '', clvOdds: r.clv_odds || null, clvPct: r.clv_pct || null, sharpClvOdds: r.sharp_clv_odds || null, sharpClvPct: r.sharp_clv_pct || null,
        fixtureId: r.fixture_id || null,
        unitAtTime,
      };
    });
    return { bets, stats: calcStats(bets, effectiveMoney.startBankroll, effectiveMoney.unitEur), _raw: data };
  }

  async function getUserUnitEur(userId) {
    const { unitEur } = await getUserMoneySettings(userId);
    return unitEur;
  }

  async function writeBet(bet, userId = null, unitEur = null) {
    const ue = unitEur ?? await getUserUnitEur(userId);
    const inzet = +(bet.units * ue).toFixed(2);
    const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
             : bet.uitkomst === 'L' ? -inzet : 0;
    const base = {
      bet_id: bet.id, datum: bet.datum, sport: bet.sport, wedstrijd: bet.wedstrijd,
      markt: bet.markt, odds: bet.odds, units: bet.units, inzet, tip: bet.tip || 'Bet365',
      uitkomst: bet.uitkomst || 'Open', wl, tijd: bet.tijd || '', score: bet.score || null,
      signals: bet.signals || '',
      user_id: userId || null,
      unit_at_time: ue,
    };
    const isColumnError = (msg) => (msg || '').toLowerCase().includes('column');
    const safeInsert = async (payload) => {
      try {
        const { error } = await supabase.from('bets').insert(payload);
        return error || null;
      } catch (e) {
        return { message: e.message };
      }
    };
    let err = await safeInsert({ ...base, fixture_id: bet.fixtureId || null });
    if (err && isColumnError(err.message)) err = await safeInsert(base);
    if (err && isColumnError(err.message)) {
      const { unit_at_time, ...legacy } = base;
      err = await safeInsert(legacy);
    }
    if (err) throw new Error(err.message);
  }

  async function updateBetOutcome(id, uitkomst, userId = null) {
    let query = supabase.from('bets').select('*').eq('bet_id', id);
    if (userId) query = query.eq('user_id', userId);
    const { data: row } = await query.single();
    if (!row) return;
    const odds = row.odds || 0;
    const units = row.units || 0;
    const userUnitEur = await getUserUnitEur(userId);
    const inzet = row.inzet != null ? row.inzet : +(units * userUnitEur).toFixed(2);
    const wl = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : uitkomst === 'L' ? -inzet : 0;
    const prevOutcome = row.uitkomst;
    let updateQuery = supabase.from('bets').update({ uitkomst, wl }).eq('bet_id', id);
    if (userId) updateQuery = updateQuery.eq('user_id', userId);
    await updateQuery;

    const prevSettled = prevOutcome === 'W' || prevOutcome === 'L';
    const newSettled = uitkomst === 'W' || uitkomst === 'L';
    if (prevSettled && prevOutcome !== uitkomst) {
      await revertCalibration({
        datum: row.datum, wedstrijd: row.wedstrijd, markt: row.markt,
        odds, units, uitkomst: prevOutcome, wl: row.wl,
        sport: row.sport || 'football', league: row.league,
        ep: row.ep, prob: row.prob,
      }, userId);
    }
    if (newSettled) {
      await updateCalibration({
        datum: row.datum, wedstrijd: row.wedstrijd, markt: row.markt,
        odds, units, uitkomst, wl,
        sport: row.sport || 'football', league: row.league,
        ep: row.ep, prob: row.prob,
      }, userId);
    }
  }

  async function deleteBet(id, userId = null) {
    let query = supabase.from('bets').delete().eq('bet_id', id);
    if (userId) query = query.eq('user_id', userId);
    await query;
  }

  return {
    calcStats,
    readBets,
    getUserUnitEur,
    writeBet,
    updateBetOutcome,
    deleteBet,
  };
};
