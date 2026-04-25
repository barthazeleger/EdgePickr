'use strict';

/**
 * v12.2.49 (R8 step 2): TTL-cache voor settled bets query, geëxtraheerd uit server.js.
 *
 * v10.10.22 fase 3 doctrine: één Supabase query voor alle consumers (kill-switch,
 * market-sample-counts, sport-caps). Voorheen 3 aparte full-table scans elke 30 min;
 * nu één scan met 5-min TTL die door alle drie wordt hergebruikt.
 *
 * Pure factory — geen externe globals. Caller mount één instance + injecteert in
 * consumers.
 *
 * @param {object} deps
 *   - supabase     — Supabase client
 *   - ttlMs        — TTL in ms (default 5 min)
 *   - select       — column-list (default standaard 6-veld set)
 * @returns {{ load: () => Promise<row[]>, invalidate: () => void, peek: () => row[] }}
 */
function createSettledBetsCache(deps = {}) {
  const supabase = deps.supabase;
  if (!supabase) throw new Error('createSettledBetsCache: missing required dep "supabase"');
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : 5 * 60 * 1000;
  const select = deps.select || 'sport, markt, uitkomst, inzet, wl, clv_pct';

  let cache = { rows: [], at: 0 };

  async function load() {
    if (cache.rows.length && Date.now() - cache.at < ttlMs) return cache.rows;
    try {
      const { data } = await supabase.from('bets').select(select).in('uitkomst', ['W', 'L']);
      cache = { rows: data || [], at: Date.now() };
      return cache.rows;
    } catch {
      // Bij Supabase-fout: laat oude cache staan (niet wissen) zodat consumer
      // niet plotseling op een lege array werkt. Stale > leeg.
      return cache.rows;
    }
  }

  function invalidate() {
    cache = { rows: [], at: 0 };
  }

  function peek() {
    return cache.rows;
  }

  return { load, invalidate, peek };
}

module.exports = { createSettledBetsCache };
