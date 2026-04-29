'use strict';

const express = require('express');
const { supportsClvForBetMarkt } = require('../clv-match');

/**
 * v11.3.5 · Phase 5.4m: Admin-inspect cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminInspectRouter({...}))`.
 *
 * Verantwoordelijkheden (alleen read-endpoints · observability/analytics):
 *   - GET /api/admin/v2/bookie-concentration  — per-bookie stake-share laatste N dagen
 *   - GET /api/admin/v2/stake-regime          — wat regime-engine ZOU beslissen op huidige bets
 *   - GET /api/admin/v2/early-payout-summary  — shadow-mode early-payout aggregaten
 *   - GET /api/admin/v2/pick-candidates-summary — pick_candidates samenvatting (accepted/rejected)
 *   - GET /api/admin/v2/clv-stats             — CLV-first KPI per sport + markt
 *   - GET /api/admin/v2/pick-funnel           — gate-cascade funnel (v15.0.2)
 *   - GET /api/admin/v2/settlement-coverage   — settlement-velocity diagnose (v15.0.2)
 *
 * @param {object} deps
 *   - supabase                    — Supabase client
 *   - requireAdmin                — Express middleware
 *   - computeBookieConcentration  — pure helper (bets, windowDays, nowMs) → concentratie
 *   - getActiveStartBankroll      — getter voor live _activeStartBankroll
 *   - aggregateEarlyPayoutStats   — lib/signals/early-payout helper
 *   - normalizeSport              — lib/model-math helper
 *   - detectMarket                — lib/model-math helper
 * @returns {express.Router}
 */
module.exports = function createAdminInspectRouter(deps) {
  const {
    supabase, requireAdmin, computeBookieConcentration,
    getActiveStartBankroll, aggregateEarlyPayoutStats,
    normalizeSport, detectMarket,
    loadUsers,
  } = deps;

  const required = {
    supabase, requireAdmin, computeBookieConcentration,
    getActiveStartBankroll, aggregateEarlyPayoutStats,
    normalizeSport, detectMarket,
    loadUsers,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminInspectRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // ── GET /api/admin/v2/bookie-concentration ───────────────────────────────
  // Per-bookie stake-share over laatste N dagen (max 60). Helpt soft-book
  // closure-risico spotten vóór de alert-drempel (>60%) fireert.
  router.get('/admin/v2/bookie-concentration', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 7));
      // v11.3.27 reviewer-fix: canonical column is `tip`, not `bookie`.
      // Eerder: `.select('bookie, ...').not('bookie', 'is', null)` gaf 500
      // "column bets.bookie does not exist". Nu: lees `tip` + map naar `bookie`
      // zodat computeBookieConcentration (pure helper) ongewijzigd blijft.
      const { data: rows, error } = await supabase.from('bets')
        .select('tip, inzet, datum').not('tip', 'is', null);
      if (error) {
        console.error('[bookie-concentration]', error.message);
        return res.status(500).json({ error: 'Interne fout · check server logs' });
      }
      const bets = (rows || []).map(r => ({ bookie: r.tip, inzet: r.inzet, datum: r.datum }));
      const conc = computeBookieConcentration(bets, days, Date.now());
      return res.json({
        windowDays: days,
        ...conc,
        alertThreshold: 0.60,
        aboveThreshold: conc.maxShare > 0.60,
      });
    } catch (e) {
      console.error('bookie-concentration error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/stake-regime ───────────────────────────────────────
  // Preview wat de unified stake-regime engine ZOU beslissen op huidige bets.
  // Gebaseerd op real-bankroll metrics (start + cumulative P/L) sinds v11.0.0.
  router.get('/admin/v2/stake-regime', requireAdmin, async (req, res) => {
    try {
      const { evaluateStakeRegime, computeBankrollMetrics } = require('../stake-regime');
      const { data: bets, error } = await supabase.from('bets')
        .select('uitkomst, clv_pct, wl, inzet, datum').in('uitkomst', ['W', 'L']);
      if (error) { console.error('[admin-inspect]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }
      const metrics = computeBankrollMetrics(bets || [], getActiveStartBankroll());

      const decision = evaluateStakeRegime({
        totalSettled: metrics.totalSettled,
        longTermClvPct: metrics.longTermClvPct,
        longTermRoi: metrics.longTermRoi,
        recentClvPct: metrics.recentClvPct,
        drawdownPct: metrics.drawdownPct,
        consecutiveLosses: metrics.consecutiveLosses,
        bankrollPeak: metrics.bankrollPeak,
        currentBankroll: metrics.currentBankroll,
      });

      res.json({
        input: {
          totalSettled: metrics.totalSettled,
          longTermClvPct: metrics.longTermClvPct,
          longTermRoi: metrics.longTermRoi,
          recentClvPct: metrics.recentClvPct,
          drawdownPct: +(metrics.drawdownPct * 100).toFixed(2) + '%',
          consecutiveLosses: metrics.consecutiveLosses,
          bankrollPeak: metrics.bankrollPeak,
          currentBankroll: metrics.currentBankroll,
          startBankroll: metrics.startBankroll,
        },
        decision,
        note: 'Engine is v11.0.0 live. Drawdown berekend t.o.v. echte bankroll (start + cumulative P/L).',
      });
    } catch (e) {
      console.error('stake-regime error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/early-payout-summary ───────────────────────────────
  // Shadow-mode readout. Per (bookie, sport, market) samples, activation en
  // conversion-rate uit early_payout_log. Geen scoring-impact tot 50+ samples
  // + bewezen lift promotie triggert.
  router.get('/admin/v2/early-payout-summary', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      const { data: rows, error } = await supabase.from('early_payout_log')
        .select('bookie_used, sport, market_type, selection_key, actual_outcome, ep_rule_applied, ep_would_have_paid, potential_lift, logged_at')
        .gte('logged_at', sinceIso);
      if (error) { console.error('[admin-inspect]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }
      const stats = aggregateEarlyPayoutStats(rows || []);
      const combinations = Object.entries(stats).map(([key, v]) => ({ key, ...v, readyForPromotion: v.samples >= 50 }));
      combinations.sort((a, b) => b.samples - a.samples);
      return res.json({
        days,
        totalRows: (rows || []).length,
        combinations,
        note: 'Shadow-mode. Samples ≥ 50 per combinatie + walk-forward bewijs van lift vereist voor promotion naar actief signaal.',
      });
    } catch (e) {
      console.error('early-payout-summary error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/pick-candidates-summary ────────────────────────────
  // Aggregaties over pick_candidates: totaal, acceptance-rate, top reject
  // reasons, breakdown per bookmaker. Helpt modelsturing zonder DB-tools.
  router.get('/admin/v2/pick-candidates-summary', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: candidates, error } = await supabase
        .from('pick_candidates')
        .select('id, fixture_id, selection_key, bookmaker, bookmaker_odds, fair_prob, edge_pct, passed_filters, rejected_reason, model_run_id, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) { console.error('[admin-inspect]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }
      const list = candidates || [];
      if (!list.length) {
        return res.json({ hours, total: 0, accepted: 0, rejected: 0, byReason: {}, byBookie: {}, recentRejected: [] });
      }
      const accepted = list.filter(c => c.passed_filters).length;
      const rejected = list.length - accepted;
      const byReason = {};
      for (const c of list) {
        if (c.passed_filters) continue;
        const cat = (c.rejected_reason || 'unknown').split(' (')[0];
        byReason[cat] = (byReason[cat] || 0) + 1;
      }
      const byBookie = {};
      for (const c of list) {
        const b = c.bookmaker || 'none';
        if (!byBookie[b]) byBookie[b] = { total: 0, accepted: 0 };
        byBookie[b].total++;
        if (c.passed_filters) byBookie[b].accepted++;
      }
      const recentRejected = list.filter(c => !c.passed_filters).slice(0, 10).map(c => ({
        id: c.id, fixture_id: c.fixture_id, selection: c.selection_key,
        bookie: c.bookmaker, odds: c.bookmaker_odds, edge: c.edge_pct,
        reason: c.rejected_reason, at: c.created_at,
      }));
      res.json({
        hours, total: list.length, accepted, rejected,
        acceptanceRate: +(accepted / list.length * 100).toFixed(1),
        byReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1])),
        byBookie,
        recentRejected,
      });
    } catch (e) {
      // v12.3.0 P2 fix: log e.message server-side voor debugging consistency
      // met andere admin-endpoints. Client krijgt generic message (no leak).
      console.error('[admin-inspect]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/clv-stats ──────────────────────────────────────────
  // CLV-first KPI per sport + markt. Reviewer-aanbeveling: CLV is hoofd-KPI
  // (winrate is te noisy bij kleine samples). Kill-switch eligibility
  // berekend per markt-bucket (n≥30 + avg CLV < -2%).
  router.get('/admin/v2/clv-stats', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
      const { data: bets, error } = await supabase.from('bets')
        .select('sport, markt, clv_pct, uitkomst, wl, datum')
        .not('clv_pct', 'is', null);
      if (error) { console.error('[admin-inspect]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }

      const all = (bets || []).filter(b =>
        typeof b.clv_pct === 'number' &&
        !isNaN(b.clv_pct) &&
        supportsClvForBetMarkt(b.markt)
      );
      if (!all.length) return res.json({ days, totalBets: 0, bySport: {}, byMarket: {}, killEligible: [] });

      const bySport = {};
      for (const b of all) {
        const s = normalizeSport(b.sport || 'football');
        if (!bySport[s]) bySport[s] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0, settledN: 0 };
        bySport[s].n++;
        bySport[s].sumClv += b.clv_pct;
        if (b.clv_pct > 0) bySport[s].positive++;
        if (b.uitkomst === 'W' || b.uitkomst === 'L') {
          bySport[s].settledN++;
          bySport[s].sumPnl += parseFloat(b.wl || 0);
        }
      }
      const sportSummary = {};
      for (const [s, d] of Object.entries(bySport)) {
        sportSummary[s] = {
          n: d.n,
          avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
          positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
          settled_n: d.settledN,
          total_pnl_eur: +d.sumPnl.toFixed(2),
        };
      }

      const byMarket = {};
      for (const b of all) {
        const s = normalizeSport(b.sport || 'football');
        const mk = detectMarket(b.markt || 'other');
        const key = `${s}_${mk}`;
        if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0 };
        byMarket[key].n++;
        byMarket[key].sumClv += b.clv_pct;
        if (b.clv_pct > 0) byMarket[key].positive++;
        if (b.uitkomst === 'W' || b.uitkomst === 'L') byMarket[key].sumPnl += parseFloat(b.wl || 0);
      }
      const marketSummary = {};
      for (const [k, d] of Object.entries(byMarket)) {
        marketSummary[k] = {
          n: d.n,
          avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
          positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
          total_pnl_eur: +d.sumPnl.toFixed(2),
        };
      }

      // Kill-switch eligibility: ≥30 bets + avg CLV < -2% → structureel negatief.
      const killEligible = [];
      for (const [k, s] of Object.entries(marketSummary)) {
        if (s.n >= 30 && s.avg_clv_pct < -2.0) {
          killEligible.push({
            key: k, n: s.n, avg_clv_pct: s.avg_clv_pct,
            recommendation: s.avg_clv_pct < -5 ? 'AUTO_DISABLE' : 'WATCHLIST',
          });
        }
      }

      res.json({
        days, totalBets: all.length,
        bySport: sportSummary,
        byMarket: marketSummary,
        killEligible,
        thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
      });
    } catch (e) {
      // v11.3.23 H3: no raw e.message to client.
      console.error('[admin-inspect]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/pick-distribution ────────────────────────────────
  // v11.3.25 · Phase 8.2: empirische distributie per (market_type × bookie ×
  // rejection_reason). Reviewer Codex #2's aanbeveling: "Add empirical
  // reporting for pick distribution by market type, preferred bookie,
  // rejection stage — so bias observations kunnen worden bevestigd met
  // data ipv intuïtie" (Over 2.5 / Bet365 / Unibet pattern).
  //
  // Query: ?hours=24 (default, max 168) & ?preferredOnly=1 (filter op
  // bookmaker in prefs — optioneel).
  router.get('/admin/v2/pick-distribution', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const preferredOnly = req.query.preferredOnly === '1' || req.query.preferredOnly === 'true';
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: candidates, error } = await supabase
        .from('pick_candidates')
        .select('bookmaker, passed_filters, rejected_reason, model_run_id, selection_key, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(10000);
      if (error) {
        console.error('[pick-distribution]', error.message);
        return res.status(500).json({ error: 'Interne fout · check server logs' });
      }
      let list = Array.isArray(candidates) ? candidates : [];

      // v11.3.27 reviewer-fix: preferredOnly daadwerkelijk implementeren.
      // Filter op user's preferredBookies set (case-insensitive substring match
      // consistent met lib/odds-parser.js bestOdds filter-logica).
      let preferredUsed = null;
      if (preferredOnly) {
        try {
          const users = await loadUsers().catch(() => []);
          const me = users.find(u => u.id === req.user?.id)
                  || users.find(u => u.role === 'admin');
          const prefs = Array.isArray(me?.settings?.preferredBookies) ? me.settings.preferredBookies : [];
          const prefsLc = prefs.map(b => String(b || '').toLowerCase()).filter(Boolean);
          if (prefsLc.length) {
            preferredUsed = prefsLc;
            list = list.filter(c => {
              const bk = String(c.bookmaker || '').toLowerCase();
              return prefsLc.some(p => bk.includes(p));
            });
          }
        } catch { /* swallow — show unfiltered */ }
      }

      if (!list.length) {
        return res.json({
          hours, total: 0, distribution: {},
          preferredOnly, preferredBookies: preferredUsed,
          note: preferredOnly && preferredUsed
            ? `0 candidates na preferred-bookie filter (${preferredUsed.join(', ')})`
            : 'geen pick_candidates in venster',
        });
      }

      // Haal model_runs op voor market_type mapping.
      const runIds = [...new Set(list.map(c => c.model_run_id).filter(Boolean))];
      let marketMap = {};
      if (runIds.length) {
        const { data: runs } = await supabase
          .from('model_runs')
          .select('id, market_type')
          .in('id', runIds);
        for (const r of (runs || [])) {
          marketMap[r.id] = r.market_type || 'unknown';
        }
      }

      // Distributie: market_type → bookie → { accepted, rejected_by_reason: {...} }
      const dist = {};
      let accepted = 0;
      let rejected = 0;
      for (const c of list) {
        const market = marketMap[c.model_run_id] || 'unknown';
        const bookie = (c.bookmaker || 'none').toLowerCase();
        if (!dist[market]) dist[market] = {};
        if (!dist[market][bookie]) dist[market][bookie] = { total: 0, accepted: 0, rejected: 0, byReason: {} };
        const bucket = dist[market][bookie];
        bucket.total++;
        if (c.passed_filters) {
          bucket.accepted++;
          accepted++;
        } else {
          bucket.rejected++;
          rejected++;
          const reason = (c.rejected_reason || 'unknown').split(' (')[0];
          bucket.byReason[reason] = (bucket.byReason[reason] || 0) + 1;
        }
      }

      // Top-line bias-indicators: per bookie de acceptance-rate.
      const byBookie = {};
      for (const market of Object.keys(dist)) {
        for (const bookie of Object.keys(dist[market])) {
          const b = dist[market][bookie];
          if (!byBookie[bookie]) byBookie[bookie] = { total: 0, accepted: 0 };
          byBookie[bookie].total += b.total;
          byBookie[bookie].accepted += b.accepted;
        }
      }
      const bookieSummary = Object.fromEntries(
        Object.entries(byBookie).map(([b, s]) => [b, {
          total: s.total, accepted: s.accepted,
          acceptanceRate: s.total > 0 ? +(s.accepted / s.total * 100).toFixed(1) : 0,
        }]).sort((a, b) => b[1].total - a[1].total)
      );

      res.json({
        hours, total: list.length, accepted, rejected,
        acceptanceRate: +(accepted / list.length * 100).toFixed(1),
        distribution: dist,
        bookieSummary,
        preferredOnly, preferredBookies: preferredUsed,
        note: preferredOnly && preferredUsed
          ? `filtered on preferred bookies (${preferredUsed.join(', ')}); distribution indexed by market_type → bookie → { total, accepted, rejected, byReason }`
          : 'distribution indexed by market_type → bookie → { total, accepted, rejected, byReason }',
      });
    } catch (e) {
      console.error('[pick-distribution]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/settlement-coverage (v15.0.2) ─────────────────────
  // Diagnose-endpoint voor settlement-velocity. Settled bets staan op 65;
  // calibratie blijft thin tot we sneller settlen. Dit endpoint laat zien:
  //   - hoe oud onze open bets zijn (24h / 48h / 7d aging buckets)
  //   - settled-instroom over laatste 14 dagen (velocity-grafiek)
  //   - per sport / bookie waar open bets zich opstapelen
  // Lees-alleen: geen auto-settle. Dat is een aparte v15.0.3 PR.
  router.get('/admin/v2/settlement-coverage', requireAdmin, async (req, res) => {
    try {
      const lookbackDays = Math.max(7, Math.min(60, parseInt(req.query.days, 10) || 14));
      const { data: rows, error } = await supabase.from('bets')
        .select('bet_id, sport, tip, uitkomst, datum, markt, wedstrijd');
      if (error) {
        console.error('[settlement-coverage]', error.message);
        return res.status(500).json({ error: 'Interne fout · check server logs' });
      }
      const all = Array.isArray(rows) ? rows : [];
      const total = all.length;

      // Datum is "DD-MM-YYYY" formaat (Nederlandse locale), parse defensief.
      const parseNlDate = (s) => {
        if (!s || typeof s !== 'string') return NaN;
        const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (!m) {
          const t = Date.parse(s);
          return Number.isFinite(t) ? t : NaN;
        }
        return Date.parse(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
      };

      const nowMs = Date.now();
      const ms = { '24h': 86400000, '48h': 2 * 86400000, '7d': 7 * 86400000, '14d': 14 * 86400000 };

      let settled = 0, open = 0;
      const aging = { open_under_24h: 0, open_24_to_48h: 0, open_48h_to_7d: 0, open_older_than_7d: 0, open_unknown_age: 0 };
      const bySport = Object.create(null);
      const byBookie = Object.create(null);
      const velocityByDay = Object.create(null);

      for (const b of all) {
        const sport = String(b.sport || 'unknown').toLowerCase();
        const bookie = String(b.tip || 'none').toLowerCase();
        const sportSlot = bySport[sport] = bySport[sport] || { open: 0, settled: 0, openOver24h: 0, openOver7d: 0 };
        const bookieSlot = byBookie[bookie] = byBookie[bookie] || { open: 0, settled: 0, openOver24h: 0 };
        const isSettled = b.uitkomst === 'W' || b.uitkomst === 'L';
        if (isSettled) {
          settled++;
          sportSlot.settled++;
          bookieSlot.settled++;
          const ageMs = nowMs - parseNlDate(b.datum);
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ms['14d']) {
            const dayKey = new Date(nowMs - ageMs).toISOString().slice(0, 10);
            velocityByDay[dayKey] = (velocityByDay[dayKey] || 0) + 1;
          }
        } else {
          open++;
          sportSlot.open++;
          bookieSlot.open++;
          const ageMs = nowMs - parseNlDate(b.datum);
          if (!Number.isFinite(ageMs)) {
            aging.open_unknown_age++;
          } else if (ageMs < ms['24h']) {
            aging.open_under_24h++;
          } else if (ageMs < ms['48h']) {
            aging.open_24_to_48h++;
            sportSlot.openOver24h++;
            bookieSlot.openOver24h++;
          } else if (ageMs < ms['7d']) {
            aging.open_48h_to_7d++;
            sportSlot.openOver24h++;
            bookieSlot.openOver24h++;
          } else {
            aging.open_older_than_7d++;
            sportSlot.openOver24h++;
            sportSlot.openOver7d++;
            bookieSlot.openOver24h++;
          }
        }
      }

      // Velocity: settled per day over de laatste lookbackDays.
      const velocity = [];
      for (let i = 0; i < lookbackDays; i++) {
        const d = new Date(nowMs - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        velocity.push({ date: key, settled: velocityByDay[key] || 0 });
      }
      const totalRecentSettled = velocity.reduce((s, v) => s + v.settled, 0);
      const avgPerDay = +(totalRecentSettled / Math.max(1, velocity.length)).toFixed(2);

      // Aging-prio: bets waarvan open + datum > 7 dagen oud zijn de hoofdpijn.
      const oldestOpen = all
        .filter(b => b.uitkomst !== 'W' && b.uitkomst !== 'L')
        .map(b => {
          const ageMs = nowMs - parseNlDate(b.datum);
          return { bet_id: b.bet_id, sport: b.sport, tip: b.tip, markt: b.markt, wedstrijd: b.wedstrijd, datum: b.datum, ageDays: Number.isFinite(ageMs) ? +(ageMs / 86400000).toFixed(1) : null };
        })
        .filter(b => Number.isFinite(b.ageDays) && b.ageDays > 7)
        .sort((a, b) => b.ageDays - a.ageDays)
        .slice(0, 25);

      // OddsPapi fetchScores diagnose (alleen wanneer ?probe=1, omdat het
      // 1 call per sport kost — quota is gratis voor /scores maar we willen
      // operator-bewuste opt-in).
      let scoreProbe = null;
      if (req.query.probe === '1') {
        try {
          const oddspapi = require('../integrations/sources/oddspapi');
          const sportKeyMap = { football: 'soccer_epl', basketball: 'basketball_nba', hockey: 'icehockey_nhl', baseball: 'baseball_mlb', 'american-football': 'americanfootball_nfl' };
          const probedSports = [...new Set(all.filter(b => b.uitkomst !== 'W' && b.uitkomst !== 'L').map(b => String(b.sport || '').toLowerCase()))];
          const results = {};
          for (const sport of probedSports) {
            const key = sportKeyMap[sport];
            if (!key) { results[sport] = { skipped: 'no_oddspapi_key' }; continue; }
            try {
              const scores = await oddspapi.fetchScores(key, 1);
              results[sport] = {
                completed_count: Array.isArray(scores) ? scores.filter(s => s.completed).length : 0,
                total_returned: Array.isArray(scores) ? scores.length : 0,
              };
            } catch (e) {
              results[sport] = { error: e?.message || String(e) };
            }
          }
          scoreProbe = results;
        } catch (e) {
          scoreProbe = { error: e?.message || String(e) };
        }
      }

      return res.json({
        windowDays: lookbackDays,
        total,
        settled,
        open,
        aging,
        velocity,
        velocitySummary: {
          totalRecentSettled,
          avgPerDay,
          windowDays: lookbackDays,
        },
        bySport,
        byBookie,
        oldestOpen,
        scoreProbe,
        note: 'Lees-alleen diagnose. Auto-settle is bewust niet ingebouwd in deze endpoint — settled.uitkomst blijft handmatig of via bestaande recalculate-route. Gebruik ?probe=1 voor optionele oddspapi /scores coverage-check (gratis quota).',
      });
    } catch (e) {
      console.error('[settlement-coverage]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/pick-funnel (v15.0.2) ─────────────────────────────
  // Eén-pane funnel-view over de gate-cascade in `lib/picks.js`. Aggregeert
  // pick_candidates (laatste N uur, default 24, max 168) langs canonieke
  // volgorde van drop-stages zodat operator in één blik ziet waar volume
  // verdwijnt — dit ondersteunt threshold-discussies met DATA, niet onderbuik.
  //
  // Near-miss: accepted picks met |probGap| ∈ [15,20]pp die wél door de
  // extreme_divergence gate (20pp) kwamen. Geen drop, alleen telemetrie.
  // Operator-vraag: "moeten we de 25→20 verlaging terugdraaien?".
  router.get('/admin/v2/pick-funnel', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const STAGES = [
        'price_too_low',
        'ep_below_min',
        'ep_too_close_to_market',
        'kelly_too_low',
        'no_signals',
        'extreme_divergence',
        'edge_below_adaptive',
        'execution_gate_skip',
      ];
      const { data: candidates, error } = await supabase
        .from('pick_candidates')
        .select('id, sport, market_type, selection_key, bookmaker, bookmaker_odds, fair_prob, edge_pct, passed_filters, rejected_reason, playability, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(20000);
      if (error) {
        console.error('[pick-funnel]', error.message);
        return res.status(500).json({ error: 'Interne fout · check server logs' });
      }
      const list = Array.isArray(candidates) ? candidates : [];

      const emptyStageBuckets = () => {
        const o = Object.create(null);
        for (const s of STAGES) o[s] = 0;
        o['playability_dropped'] = 0;
        o['accepted'] = 0;
        return o;
      };

      const total = list.length;
      const baseBuckets = emptyStageBuckets();
      const bySportBuckets = Object.create(null);
      const byMarketBuckets = Object.create(null);
      let acceptedCount = 0;
      let playabilityDroppedCount = 0;

      // Near-miss aggregation: accepted picks (passed_filters=true) waar
      // |probGap| ∈ [15,20]pp. Geeft inzicht of de extreme_divergence-gate
      // (20pp + auditSuspicious) net niet bijt op marginale picks.
      const nearMissSamples = [];
      let nearMissCount = 0;

      const slot = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
      const ensure = (target, key) => {
        if (!target[key]) target[key] = emptyStageBuckets();
        return target[key];
      };

      for (const c of list) {
        const sportKey = String(c.sport || 'unknown').toLowerCase();
        const marketKey = String(c.market_type || 'unknown').toLowerCase();
        const sportSlot = ensure(bySportBuckets, sportKey);
        const marketSlot = ensure(byMarketBuckets, marketKey);

        if (c.passed_filters) {
          // Accepted by mkP. Check playability post-drop via JSONB column.
          const play = c.playability && typeof c.playability === 'object' ? c.playability : null;
          // playabilityAudit shape: { executable, dataRich, lineQuality, playable, coverageKnown }
          const playable = play && Object.prototype.hasOwnProperty.call(play, 'playable')
            ? !!play.playable
            : null;
          if (playable === false) {
            playabilityDroppedCount++;
            slot(baseBuckets, 'playability_dropped');
            slot(sportSlot, 'playability_dropped');
            slot(marketSlot, 'playability_dropped');
          } else {
            acceptedCount++;
            slot(baseBuckets, 'accepted');
            slot(sportSlot, 'accepted');
            slot(marketSlot, 'accepted');
          }
        } else {
          const reasonRaw = (c.rejected_reason || 'unknown').split(' (')[0];
          const reason = STAGES.includes(reasonRaw) ? reasonRaw : 'unknown';
          slot(baseBuckets, reason);
          slot(sportSlot, reason);
          slot(marketSlot, reason);
        }

        // Near-miss: probGap berekening — fair_prob is decimal (0..1), odds is decimal odds.
        const odds = parseFloat(c.bookmaker_odds);
        const fairProb = parseFloat(c.fair_prob);
        if (Number.isFinite(odds) && odds > 1.01 && Number.isFinite(fairProb) && fairProb > 0 && fairProb < 1) {
          const baselineProb = 100 / odds;          // pp
          const modelProb = fairProb * 100;          // pp
          const probGap = +(modelProb - baselineProb).toFixed(1);
          if (Math.abs(probGap) >= 15 && Math.abs(probGap) <= 20 && c.passed_filters) {
            nearMissCount++;
            if (nearMissSamples.length < 10) {
              nearMissSamples.push({
                id: c.id, sport: c.sport, market_type: c.market_type,
                selection: c.selection_key, bookie: c.bookmaker,
                odds, model_prob_pct: +modelProb.toFixed(1),
                baseline_prob_pct: +baselineProb.toFixed(1),
                prob_gap_pp: probGap, edge_pct: c.edge_pct,
                at: c.created_at,
              });
            }
          }
        }
      }

      // Build cascade: stage[i].dropped = bucket count, survivingAfter = total - cumulative drops.
      const buildStages = (buckets, totalForScope) => {
        let cumulativeDropped = 0;
        const stages = [];
        for (const name of STAGES) {
          const dropped = buckets[name] || 0;
          cumulativeDropped += dropped;
          stages.push({
            name,
            dropped,
            survivingAfter: Math.max(0, totalForScope - cumulativeDropped),
          });
        }
        // Append playability as the final stage (post-mkP).
        const playDropped = buckets['playability_dropped'] || 0;
        cumulativeDropped += playDropped;
        stages.push({
          name: 'playability_dropped',
          dropped: playDropped,
          survivingAfter: Math.max(0, totalForScope - cumulativeDropped),
        });
        return stages;
      };

      const totalsBySport = {};
      for (const [k, b] of Object.entries(bySportBuckets)) {
        const t = Object.values(b).reduce((s, n) => s + n, 0);
        totalsBySport[k] = { total: t, stages: buildStages(b, t), accepted: b.accepted || 0 };
      }
      const totalsByMarket = {};
      for (const [k, b] of Object.entries(byMarketBuckets)) {
        const t = Object.values(b).reduce((s, n) => s + n, 0);
        totalsByMarket[k] = { total: t, stages: buildStages(b, t), accepted: b.accepted || 0 };
      }

      return res.json({
        windowHours: hours,
        sinceIso,
        total,
        accepted: acceptedCount,
        playabilityDropped: playabilityDroppedCount,
        stages: buildStages(baseBuckets, total),
        bySport: totalsBySport,
        byMarket: totalsByMarket,
        nearMiss: {
          extreme_divergence: {
            range_pp: [15, 20],
            count: nearMissCount,
            samples: nearMissSamples,
            note: 'Accepted picks met |probGap| net onder de 20pp extreme_divergence drempel. Geen drop — alleen telemetrie zodat operator kan beoordelen of de v12.2.31 verlaging (25→20) terug naar 22-25pp moet.',
          },
        },
        note: 'Funnel reconstructed from pick_candidates (laatste N uur). playability_dropped wordt gelezen uit pick_candidates.playability JSONB; null/missing → niet als drop geteld. Stages volgen exact de cascade in lib/picks.js.',
      });
    } catch (e) {
      console.error('[pick-funnel]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/scan-by-sport (v12.2.30) ──────────────────────────
  // Sport-aware breakdown van pick_candidates. Beantwoord operator-vraag:
  // "waarom 2 hockey picks en 0 voetbal terwijl er honderden voetbalwed-
  // strijden zijn?". Per sport: total candidates, accepted, top reject-
  // reasons. Vereist join met fixtures.sport via model_runs.fixture_id.
  router.get('/admin/v2/scan-by-sport', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: cands } = await supabase.from('pick_candidates')
        .select('passed_filters, rejected_reason, model_run_id, model_runs!inner(fixture_id, market_type)')
        .gte('created_at', sinceIso)
        .limit(20000);
      const list = Array.isArray(cands) ? cands : [];
      if (!list.length) return res.json({ hours, total: 0, bySport: {} });

      const fxIds = [...new Set(list.map(c => c.model_runs?.fixture_id).filter(Boolean))];
      const fxSport = new Map();
      for (let i = 0; i < fxIds.length; i += 200) {
        const chunk = fxIds.slice(i, i + 200);
        const { data: fxs } = await supabase.from('fixtures').select('id, sport').in('id', chunk);
        for (const f of (fxs || [])) fxSport.set(f.id, f.sport || 'unknown');
      }

      const bySport = {};
      for (const c of list) {
        const sport = fxSport.get(c.model_runs?.fixture_id) || 'unknown';
        if (!bySport[sport]) {
          bySport[sport] = { total: 0, accepted: 0, rejected: 0, byReason: {}, byMarket: {} };
        }
        const b = bySport[sport];
        b.total++;
        const mkt = c.model_runs?.market_type || 'unknown';
        b.byMarket[mkt] = (b.byMarket[mkt] || 0) + 1;
        if (c.passed_filters) {
          b.accepted++;
        } else {
          b.rejected++;
          const reason = (c.rejected_reason || 'unknown').split(' (')[0];
          b.byReason[reason] = (b.byReason[reason] || 0) + 1;
        }
      }
      // Top-3 reject-reasons + acceptance rate per sport.
      const summary = {};
      for (const [sport, b] of Object.entries(bySport)) {
        const top = Object.entries(b.byReason).sort((x, y) => y[1] - x[1]).slice(0, 5);
        summary[sport] = {
          total: b.total,
          accepted: b.accepted,
          rejected: b.rejected,
          acceptanceRate: b.total ? +(b.accepted / b.total * 100).toFixed(1) : 0,
          topRejectReasons: Object.fromEntries(top),
          byMarket: b.byMarket,
        };
      }
      res.json({ hours, sinceIso, total: list.length, bySport: summary });
    } catch (e) {
      console.error('[scan-by-sport]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/tsdb-utilization (v15.0.12) ───────────────────────
  // Per-endpoint TSDB call breakdown + percentage van theoretical daily
  // budget. Hot-endpoint flag wanneer endpoint-pct > 10% van budget.
  // Operator-input voor toekomstige throttling-policies en under-use audit.
  router.get('/admin/v2/tsdb-utilization', requireAdmin, async (req, res) => {
    try {
      const tsdb = require('../integrations/sources/thesportsdb');
      const usage = tsdb.getUsage();
      const HOT_THRESHOLD_PCT = 10.0;
      const breakdown = Object.entries(usage.byEndpoint || {}).map(([ep, n]) => ({
        endpoint: ep,
        calls: n,
        percentOfBudget: usage.byEndpointPercent?.[ep] ?? 0,
        hot: (usage.byEndpointPercent?.[ep] ?? 0) > HOT_THRESHOLD_PCT,
      })).sort((a, b) => b.calls - a.calls);
      const knownPremiumEndpoints = [
        'searchteams', 'lookuph2h', 'eventslast', 'eventsday',
        'eventsnextleague', 'eventspastleague', 'lookuptable',
        'lookuplineup', 'lookupeventstats', 'lookuptimeline',
        'lookuptv', 'lookupvenue', 'lookup_all_players',
        'livescore', 'schedule',
      ];
      const usedKeys = new Set(breakdown.map(b => b.endpoint));
      const dormant = knownPremiumEndpoints.filter(k => !usedKeys.has(k));
      res.json({
        source: usage.source,
        date: usage.date,
        premium: usage.premium,
        rateLimitMs: usage.rateLimitMs,
        callsToday: usage.callsToday,
        dailyBudget: usage.dailyBudget,
        utilizationPct: usage.utilizationPct,
        hotThresholdPct: HOT_THRESHOLD_PCT,
        breakdown,
        dormantEndpoints: dormant,
        note: 'utilizationPct = callsToday / dailyBudget * 100. Premium budget ≈ 144k/dag (100/min). Hot=endpoint >10% van budget. Dormant=endpoints aanwezig in adapter maar niet aangeroepen vandaag.',
      });
    } catch (e) {
      console.error('[tsdb-utilization]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
