'use strict';

/**
 * v15.3.0 · Expansion-graduation evaluator.
 *
 * Pure helper. Krijgt een lijst settled `expansion_shadow_paper`-rows en
 * past 6-dimensionale promotion-gates per liga toe. Multi-dim design
 * voorkomt single-metric promotion (BTTS-bug doctrine: "n hoog dus
 * multiplier hoger ondanks verlies").
 *
 * Gates (alle 6 moeten passen voor `graduation_ready=true`):
 *   1. n ≥ 30                           — sample size
 *   2. avg_clv_pct ≥ +0.5%             — écht positief, niet net boven nul
 *   3. roi_pct ≥ -2%                    — geen structureel verlies
 *   4. positive_clv_rate ≥ 50%          — consistentie
 *   5. preferred_bookie_coverage_rate ≥ 50% (≥ 3 preferred bookies in payload)
 *   6. recent_n ≥ 20 (laatste 4 weken)  — geen ancient signals
 *
 * Auto-demote criteria (apart, alleen wanneer liga reeds gepromoot is):
 *   - n_real ≥ 30 settled echte-money picks na promotie
 *   - avg_clv_pct < 0% over die n_real → demote terug naar shadow
 *
 * Niet-doel: api-sports league.id resolve. Caller moet bij promotion
 * besluit zelf de api-sports id koppelen (TSDB→api-sports mapping is
 * niet betrouwbaar automatisch).
 */

const DEFAULT_GATES = Object.freeze({
  min_n: 30,
  min_avg_clv_pct: 0.5,
  min_roi_pct: -2.0,
  min_positive_clv_rate: 50.0,
  min_preferred_coverage_rate: 50.0,
  min_preferred_bookie_count: 3,
  min_recent_n: 20,
});

const DEFAULT_PREFERRED_BOOKIES = Object.freeze([
  'bet365', 'unibet', 'toto', 'betcity', '888sport', 'betmgm',
]);

/**
 * @param {Array} rows - settled expansion-shadow rows uit pick_candidates
 * @param {object} opts
 *   - recentSinceMs: ms-cutoff voor recent_n (default = nu - 4w)
 *   - gates: override defaults
 *   - preferredBookies: lijst lowercased bookie-keys
 * @returns {{candidates: Array, gates, preferredBookies, summary}}
 */
function evaluateGraduation(rows, opts = {}) {
  const gates = { ...DEFAULT_GATES, ...(opts.gates || {}) };
  const preferredBookies = Array.isArray(opts.preferredBookies) && opts.preferredBookies.length
    ? opts.preferredBookies.map(b => String(b).toLowerCase().trim())
    : DEFAULT_PREFERRED_BOOKIES.slice();
  const preferredSet = new Set(preferredBookies);
  const recentSinceMs = Number.isFinite(opts.recentSinceMs)
    ? opts.recentSinceMs
    : Date.now() - 4 * 7 * 86400000;

  const byLeague = Object.create(null);
  for (const r of Array.isArray(rows) ? rows : []) {
    const leagueName = (r?.source_attribution?.thesportsdb?.leagueName || 'unknown')
      .toLowerCase().trim();
    if (!byLeague[leagueName]) {
      byLeague[leagueName] = {
        leagueName,
        n: 0,
        wins: 0, losses: 0, pushes: 0,
        sumClv: 0, clvCount: 0, positiveClv: 0,
        sumPnlUnits: 0, sumStakeUnits: 0,
        bookiesSeen: new Set(),
        preferredBookieRows: 0,
        recentN: 0,
        sample: [],
      };
    }
    const slot = byLeague[leagueName];
    slot.n++;
    if (r.result === 'W') slot.wins++;
    else if (r.result === 'L') slot.losses++;
    else if (r.result === 'P') slot.pushes++;

    if (typeof r.clv_pct === 'number' && Number.isFinite(r.clv_pct)) {
      slot.sumClv += r.clv_pct;
      slot.clvCount++;
      if (r.clv_pct > 0) slot.positiveClv++;
    }

    const odds = parseFloat(r.bookmaker_odds);
    if (Number.isFinite(odds) && odds > 1 && (r.result === 'W' || r.result === 'L' || r.result === 'P')) {
      slot.sumStakeUnits += 1;
      if (r.result === 'W') slot.sumPnlUnits += (odds - 1);
      else if (r.result === 'L') slot.sumPnlUnits += -1;
      // 'P' (push) → +0
    }

    const bookie = String(r.bookmaker || '').toLowerCase().trim();
    if (bookie) slot.bookiesSeen.add(bookie);

    const anchorSample = Array.isArray(r?.sharp_anchor?.sample) ? r.sharp_anchor.sample : [];
    const anchorBookies = new Set(anchorSample
      .map(s => String(s?.bookie || '').toLowerCase().trim())
      .filter(Boolean));
    let preferredHits = 0;
    for (const b of preferredSet) if (anchorBookies.has(b)) preferredHits++;
    if (preferredHits >= gates.min_preferred_bookie_count) slot.preferredBookieRows++;

    const settledMs = Date.parse(r.settled_at || '');
    if (Number.isFinite(settledMs) && settledMs >= recentSinceMs) slot.recentN++;

    if (slot.sample.length < 3) {
      slot.sample.push({
        id: r.id, fixture_id: r.fixture_id, markt_label: r.markt_label,
        odds: r.bookmaker_odds, result: r.result, clv_pct: r.clv_pct,
      });
    }
  }

  const candidates = [];
  for (const slot of Object.values(byLeague)) {
    const avg_clv_pct = slot.clvCount > 0
      ? +(slot.sumClv / slot.clvCount).toFixed(2) : null;
    const positive_clv_rate = slot.clvCount > 0
      ? +(slot.positiveClv / slot.clvCount * 100).toFixed(1) : null;
    const roi_pct = slot.sumStakeUnits > 0
      ? +(slot.sumPnlUnits / slot.sumStakeUnits * 100).toFixed(1) : null;
    const preferred_coverage_rate = slot.n > 0
      ? +(slot.preferredBookieRows / slot.n * 100).toFixed(1) : 0;
    const win_rate_pct = (slot.wins + slot.losses) > 0
      ? +(slot.wins / (slot.wins + slot.losses) * 100).toFixed(1) : null;

    const checks = {
      n: { value: slot.n, threshold: gates.min_n, pass: slot.n >= gates.min_n },
      avg_clv_pct: {
        value: avg_clv_pct, threshold: gates.min_avg_clv_pct,
        pass: avg_clv_pct != null && avg_clv_pct >= gates.min_avg_clv_pct,
      },
      roi_pct: {
        value: roi_pct, threshold: gates.min_roi_pct,
        pass: roi_pct != null && roi_pct >= gates.min_roi_pct,
      },
      positive_clv_rate: {
        value: positive_clv_rate, threshold: gates.min_positive_clv_rate,
        pass: positive_clv_rate != null && positive_clv_rate >= gates.min_positive_clv_rate,
      },
      preferred_bookie_coverage: {
        value: preferred_coverage_rate, threshold: gates.min_preferred_coverage_rate,
        pass: preferred_coverage_rate >= gates.min_preferred_coverage_rate
          && slot.preferredBookieRows >= gates.min_preferred_bookie_count,
      },
      recent_n: {
        value: slot.recentN, threshold: gates.min_recent_n,
        pass: slot.recentN >= gates.min_recent_n,
      },
    };
    const all_pass = Object.values(checks).every(c => c.pass === true);
    const failures = Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => k);

    candidates.push({
      leagueName: slot.leagueName,
      n: slot.n,
      wins: slot.wins, losses: slot.losses, pushes: slot.pushes,
      win_rate_pct,
      avg_clv_pct, positive_clv_rate, roi_pct,
      preferred_coverage_rate,
      recent_n: slot.recentN,
      unique_bookies_count: slot.bookiesSeen.size,
      checks,
      graduation_ready: all_pass,
      missing_gates: all_pass ? [] : failures,
      sample: slot.sample,
    });
  }
  candidates.sort((a, b) =>
    Number(b.graduation_ready) - Number(a.graduation_ready) || (b.n - a.n));

  return {
    candidates,
    gates,
    preferredBookies,
    summary: {
      totalRows: (rows || []).length,
      leagueCount: Object.keys(byLeague).length,
      graduationReadyCount: candidates.filter(c => c.graduation_ready).length,
    },
  };
}

module.exports = {
  evaluateGraduation,
  DEFAULT_GATES,
  DEFAULT_PREFERRED_BOOKIES,
};
