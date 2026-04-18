'use strict';

const express = require('express');

/**
 * v11.3.14 · Phase 5.4v: Debug diagnostic routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createDebugRouter({...}))`.
 *
 * Endpoints (allemaal admin-only):
 *   - GET /api/debug/odds?sport=X&date=YYYY-MM-DD&team=Y&wide=1
 *     Dumpt raw api-sports odds voor max 5 matches om 3-way detectie + bookie
 *     coverage te verifiëren.
 *   - GET /api/debug/wl?all=1
 *     Settled bets data voor bankroll diagnose (eigen user of all).
 *
 * @param {object} deps
 *   - requireAdmin        — middleware
 *   - normalizeSport      — fn (sport) → string
 *   - getSportApiConfig   — fn (sport) → { host, fixturesPath, oddsPath, fixtureParam }
 *   - afGet               — async (host, path, params) → any
 *   - readBets            — async (userId) → { bets, stats }
 *   - calcStats           — fn (bets) → stats
 * @returns {express.Router}
 */
module.exports = function createDebugRouter(deps) {
  const { requireAdmin, normalizeSport, getSportApiConfig, afGet, readBets, calcStats } = deps;

  const required = { requireAdmin, normalizeSport, getSportApiConfig, afGet, readBets, calcStats };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createDebugRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/debug/odds', requireAdmin, async (req, res) => {
    try {
      const sport = normalizeSport(req.query.sport || 'hockey');
      const windowDays = req.query.wide === '1' ? [-2,-1,0,1] : [-1,0,1];
      const team = (req.query.team || '').toLowerCase();
      const cfg = getSportApiConfig(sport);
      const datesFromParam = req.query.date ? [req.query.date] : windowDays.map(o => {
        const d = new Date(Date.now() + o * 86400000);
        return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      });
      let allGames = [];
      const fetchedPerDate = {};
      for (const date of datesFromParam) {
        const games = await afGet(cfg.host, cfg.fixturesPath, { date }).catch(err => { console.error('debug odds fixtures fout', err); return []; });
        fetchedPerDate[date] = (games || []).length;
        for (const g of (games || [])) allGames.push(g);
      }
      const matches = allGames.filter(g => {
        const h = (g.teams?.home?.name || '').toLowerCase();
        const a = (g.teams?.away?.name || '').toLowerCase();
        return !team || h.includes(team) || a.includes(team);
      }).slice(0, 5);
      const out = [];
      for (const g of matches) {
        const id = sport === 'football' ? g.fixture?.id : g.id;
        if (!id) continue;
        const odds = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: id }).catch(err => { console.error('debug odds fout', err); return []; });
        const first = Array.isArray(odds) ? odds[0] : odds;
        const rawBookmakers = first?.bookmakers || [];
        const bookmakers = rawBookmakers.map(bk => ({
          bookie: bk?.name || 'unknown',
          bets: (bk?.bets || []).map(b => {
            const vals = Array.isArray(b?.values) ? b.values : [];
            return {
              id: b?.id, name: b?.name,
              values: vals.map(v => ({ value: v?.value, odd: v?.odd })),
              valueCount: vals.length,
              is3Way: vals.filter(v => ['Home','Draw','Away','1','X','2'].includes(String(v?.value ?? '').trim())).length === 3,
            };
          }),
        }));
        const gDate = g.fixture?.date || g.date || null;
        const nlDateTime = gDate ? new Date(gDate).toLocaleString('nl-NL', {
          weekday:'short', day:'2-digit', month:'short', year:'numeric',
          hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam'
        }) : null;
        out.push({
          id, home: g.teams?.home?.name, away: g.teams?.away?.name,
          dateUTC: gDate, dateNL: nlDateTime,
          status: g.fixture?.status?.short || g.status?.short || null,
          league: g.league?.name || null,
          bookmakers,
        });
      }
      res.json({ sport, datesSearched: datesFromParam, fetchedPerDate, matchesFound: matches.length, matches: out });
    } catch (e) {
      console.error('debug/odds fout:', e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  router.get('/debug/wl', requireAdmin, async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets } = await readBets(userId);
      const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
      res.json({ settledCount: settled.length, bets: settled, stats: calcStats(bets) });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
