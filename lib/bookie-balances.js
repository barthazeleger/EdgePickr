'use strict';

/**
 * v12.2.0 · Per-bookie bankroll tracking.
 *
 * Pure helpers + Supabase-backed store. Eén rij per (user_id, bookie).
 * Balance-wijzigingen zijn point-in-time impact van een bet op de bookie:
 *
 *   Open: -inzet (stake vastgehouden bij bookie)
 *   W:    +(odds - 1) × inzet (cumulatief: -inzet + payout = +winst)
 *   L:    -inzet (stake verloren)
 *
 * Transitions:
 *   delta(oldOutcome → newOutcome) = impact(new) - impact(old)
 *
 * Delete:
 *   delta = -impact(current)  (reverse alles wat de bet deed)
 *
 * Bookie-naam wordt genormaliseerd naar lowercase voor opslag; canonical
 * display-naam blijft bij de caller.
 */

const ALERT_THRESHOLD_EUR = 25; // 1 unit @ €25 default

function normalizeBookieKey(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Impact van één bet op de bookie-balance (cumulatief, vanaf 0).
 * - inzet: stake
 * - odds: decimal odd
 * - uitkomst: 'Open' | 'W' | 'L'
 */
function betBalanceImpact({ inzet, odds, uitkomst }) {
  const stake = Number(inzet) || 0;
  const o = Number(odds) || 0;
  if (uitkomst === 'W') return +((o - 1) * stake).toFixed(2);
  if (uitkomst === 'L') return +(-stake).toFixed(2);
  return +(-stake).toFixed(2); // Open (stake held)
}

function transitionDelta(oldBet, newBet) {
  return +(betBalanceImpact(newBet) - betBalanceImpact(oldBet)).toFixed(2);
}

/**
 * Factory. Maakt een store met Supabase-backed CRUD + bet-hooks.
 *
 * @param {object} deps
 *   - supabase: Supabase client
 */
function createBookieBalanceStore(deps) {
  const { supabase } = deps;
  if (!supabase) throw new Error('createBookieBalanceStore: missing supabase dep');

  /**
   * Lees alle balances voor een user. Returnt [{ bookie, balance, updated_at }].
   */
  async function listBalances(userId) {
    let q = supabase.from('bookie_balances').select('bookie, balance, updated_at');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) {
      if (/relation.*does not exist/i.test(String(error.message || ''))) return [];
      throw new Error(error.message);
    }
    return (data || []).map(r => ({
      bookie: r.bookie,
      balance: +Number(r.balance).toFixed(2),
      updated_at: r.updated_at,
    }));
  }

  /**
   * Zet balance voor één bookie (handmatige correctie / init).
   */
  async function setBalance(userId, bookie, newBalance) {
    const key = normalizeBookieKey(bookie);
    if (!key) throw new Error('setBalance: bookie is required');
    const bal = +Number(newBalance).toFixed(2);
    if (!Number.isFinite(bal)) throw new Error('setBalance: invalid balance');
    const row = { user_id: userId || null, bookie: key, balance: bal, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('bookie_balances')
      .upsert(row, { onConflict: 'user_id,bookie' });
    if (error) throw new Error(error.message);
    return { bookie: key, balance: bal };
  }

  /**
   * Pas delta toe op balance (auto-create met delta als rij ontbreekt).
   * v12.2.6 (F2): primair via Postgres RPC `bookie_balance_apply_delta` —
   * atomic UPSERT met balance+=delta, race-vrij. Fallback naar legacy
   * read-calc-write als RPC niet bestaat (oude DB zonder migratie v12.2.6).
   */
  async function applyDelta(userId, bookie, delta) {
    const key = normalizeBookieKey(bookie);
    if (!key) return;
    const d = Number(delta) || 0;
    if (!d) return;

    // Tier-1: RPC (atomic).
    try {
      const { data, error } = await supabase.rpc('bookie_balance_apply_delta', {
        p_user_id: userId || null,
        p_bookie: key,
        p_delta: +d.toFixed(2),
      });
      if (!error) {
        const newBal = Number(data);
        return { bookie: key, balance: Number.isFinite(newBal) ? +newBal.toFixed(2) : null, delta: d };
      }
      // Function-not-found of relation-missing → fallback.
      if (!/function|does not exist|not found/i.test(String(error.message || ''))) {
        throw new Error(error.message);
      }
    } catch (e) {
      // Onverwachte exception → log + fallback.
      if (!/function|does not exist|not found/i.test(String(e.message || ''))) {
        console.warn('[bookie-balance] RPC failed, falling back:', e.message);
      }
    }

    // Tier-2 (fallback, race-prone): read-calc-write. Alleen actief als RPC
    // ontbreekt (pre-v12.2.6 DB schema). Logged warn zodat ops het opvalt.
    let q = supabase.from('bookie_balances').select('balance').eq('bookie', key);
    if (userId) q = q.eq('user_id', userId);
    const { data: rows, error: selErr } = await q.limit(1);
    if (selErr && !/relation.*does not exist/i.test(String(selErr.message || ''))) {
      throw new Error(selErr.message);
    }
    const current = rows && rows.length ? Number(rows[0].balance) || 0 : 0;
    const next = +(current + d).toFixed(2);

    const row = { user_id: userId || null, bookie: key, balance: next, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('bookie_balances')
      .upsert(row, { onConflict: 'user_id,bookie' });
    if (error && !/relation.*does not exist/i.test(String(error.message || ''))) {
      throw new Error(error.message);
    }
    return { bookie: key, balance: next, delta: d };
  }

  /**
   * Bet-flow hook: roep dit aan bij writeBet met de nieuw gelogde bet.
   * Past impact toe op balance (bv. Open → -inzet).
   */
  async function onBetWritten(userId, bet) {
    if (!bet || !bet.tip) return;
    const impact = betBalanceImpact({
      inzet: bet.inzet,
      odds: bet.odds,
      uitkomst: bet.uitkomst || 'Open',
    });
    if (!impact) return;
    return applyDelta(userId, bet.tip, impact);
  }

  /**
   * Bet-flow hook: roep dit aan bij updateBetOutcome met oude + nieuwe staat.
   * Past (newImpact - oldImpact) toe op balance.
   */
  async function onBetOutcomeChanged(userId, { bookie, inzet, odds, prevOutcome, newOutcome }) {
    if (!bookie) return;
    const delta = transitionDelta(
      { inzet, odds, uitkomst: prevOutcome },
      { inzet, odds, uitkomst: newOutcome },
    );
    if (!delta) return;
    return applyDelta(userId, bookie, delta);
  }

  /**
   * Bet-flow hook: roep dit aan bij deleteBet met de bet-row die verdwijnt.
   * Reverse de cumulative impact.
   */
  async function onBetDeleted(userId, bet) {
    if (!bet || !bet.tip) return;
    const impact = betBalanceImpact({
      inzet: bet.inzet,
      odds: bet.odds,
      uitkomst: bet.uitkomst || 'Open',
    });
    if (!impact) return;
    return applyDelta(userId, bet.tip, -impact);
  }

  /**
   * Totaal over alle bookies voor een user.
   */
  async function totalBalance(userId) {
    const list = await listBalances(userId);
    return +list.reduce((s, r) => s + r.balance, 0).toFixed(2);
  }

  /**
   * Bookies onder drempel (default 25 EUR = 1 unit). Voor alerts.
   */
  async function lowBalances(userId, threshold = ALERT_THRESHOLD_EUR) {
    const list = await listBalances(userId);
    return list.filter(r => r.balance < threshold);
  }

  return {
    listBalances,
    setBalance,
    applyDelta,
    onBetWritten,
    onBetOutcomeChanged,
    onBetDeleted,
    totalBalance,
    lowBalances,
  };
}

module.exports = {
  createBookieBalanceStore,
  betBalanceImpact,
  transitionDelta,
  normalizeBookieKey,
  ALERT_THRESHOLD_EUR,
};
