'use strict';

const express = require('express');

/**
 * v11.2.4 · Phase 5.4b: Tracker routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createTrackerRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET  /api/check-results — draai checkOpenBetResults voor (admin's? all?) bets
 *     en retourneer updated-uitkomst + verse bets/stats.
 *   - POST /api/backfill-times (admin) — vul ontbrekende kickoff-tijden via api-football.
 *
 * @param {object} deps
 *   - supabase               — Supabase client
 *   - requireAdmin           — Express middleware
 *   - readBets               — async (userId) → {bets, stats}
 *   - checkOpenBetResults    — async (userId) → {checked, updated, results}
 *   - afGet                  — async (host, path, params) → array (api-football GET)
 *   - sleep                  — async (ms) → void
 * @returns {express.Router}
 */
module.exports = function createTrackerRouter(deps) {
  const { supabase, requireAdmin, readBets, checkOpenBetResults, afGet, sleep } = deps;

  const required = { supabase, requireAdmin, readBets, checkOpenBetResults, afGet, sleep };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createTrackerRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/check-results', async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const result = await checkOpenBetResults(userId);
      const { bets, stats } = await readBets(userId);
      res.json({ ...result, bets, stats });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // Eenmalig: kickofftijden invullen voor bets zonder tijd.
  router.post('/backfill-times', requireAdmin, async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets } = await readBets(userId);
      const results = [];

      for (let i = 0; i < bets.length; i++) {
        const b = bets[i];
        // altijd overschrijven zodat foute tijden gecorrigeerd worden

        // Zoek fixture op datum + teamnaam
        const dateStr = b.datum.split('-').reverse().join('-'); // dd-mm-yyyy → yyyy-mm-dd
        const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: dateStr });
        await sleep(200);

        const [tA, tB] = b.wedstrijd.toLowerCase().split(' vs ').map(t => t.trim());
        // Zoek fixture waar BEIDE teams (deels) matchen · voorkomt jeugd/reserve wedstrijden
        let match = fixtures.find(f => {
          const home = f.teams?.home?.name?.toLowerCase() || '';
          const away = f.teams?.away?.name?.toLowerCase() || '';
          const homeMatch = home.includes(tA.split(' ')[0]) || tA.includes(home.split(' ')[0]);
          const awayMatch = away.includes(tB.split(' ')[0]) || tB.includes(away.split(' ')[0]);
          return homeMatch && awayMatch;
        });
        // Fallback: één team matcht, maar neem de LAATSTE kickoff (meest waarschijnlijk hoofdteam)
        if (!match) {
          const candidates = fixtures.filter(f => {
            const home = f.teams?.home?.name?.toLowerCase() || '';
            const away = f.teams?.away?.name?.toLowerCase() || '';
            return home.includes(tA.split(' ')[0]) || tA.includes(home.split(' ')[0]) ||
                   away.includes(tB.split(' ')[0]) || tB.includes(away.split(' ')[0]);
          });
          match = candidates.sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))[0];
        }

        if (!match) { results.push({ id: b.id, status: 'niet gevonden', wedstrijd: b.wedstrijd }); continue; }

        const rawDate = match.fixture?.date || '';
        const tijd = new Date(rawDate).toLocaleTimeString('nl-NL', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
        });

        // Schrijf naar Supabase
        await supabase.from('bets').update({ tijd }).eq('bet_id', b.id);

        results.push({ id: b.id, status: 'bijgewerkt', wedstrijd: b.wedstrijd, tijd, rawDate });
      }

      res.json({ results });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
