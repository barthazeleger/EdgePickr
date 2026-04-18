'use strict';

const express = require('express');
const { teamMatchScore } = require('../model-math');

/**
 * v11.3.11 · Phase 5.4s: POTD + match analyser extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAnalyzeRouter({...}))`.
 *
 * Endpoints:
 *   - GET  /api/potd     — Pick-of-the-Day post generator (Reddit + X formats)
 *   - POST /api/analyze  — natural-language match lookup (multi-sport, fuzzy)
 *
 * @param {object} deps
 *   - rateLimit                  — fn (key, maxCount, windowMs) → boolean
 *   - requireAdmin               — middleware
 *   - getLastPrematchPicks       — fn () → Array (live mutable ref)
 *   - getLastLivePicks           — fn () → Array (live mutable ref)
 *   - loadScanHistoryFromSheets  — async () → Array
 *   - loadScanHistory            — async () → Array
 *   - getUserMoneySettings       — async (userId) → { unitEur, startBankroll }
 *   - readBets                   — async (userId, money) → { bets, stats }
 *   - loadUsers                  — async () → users[]
 *   - afGet                      — async (host, path, params) → any
 *   - getSportApiConfig          — fn (sport) → { host, fixturesPath }
 * @returns {express.Router}
 */
module.exports = function createAnalyzeRouter(deps) {
  const {
    rateLimit,
    requireAdmin,
    getLastPrematchPicks,
    getLastLivePicks,
    loadScanHistoryFromSheets,
    loadScanHistory,
    getUserMoneySettings,
    readBets,
    loadUsers,
    afGet,
    getSportApiConfig,
  } = deps;

  const required = {
    rateLimit, requireAdmin,
    getLastPrematchPicks, getLastLivePicks,
    loadScanHistoryFromSheets, loadScanHistory,
    getUserMoneySettings, readBets,
    loadUsers, afGet, getSportApiConfig,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAnalyzeRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/potd', requireAdmin, async (req, res) => {
    try {
      let allPicks = [...getLastPrematchPicks(), ...getLastLivePicks()];
      if (!allPicks.length) {
        const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
        if (history.length) {
          const raw = history[0].picks || [];
          const selectedOnly = raw.filter(p => p.selected !== false);
          allPicks = selectedOnly.length ? selectedOnly : raw;
        }
      }
      if (!allPicks.length) return res.json({ error: 'Geen picks beschikbaar · draai eerst een scan' });

      const pick = [...allPicks].sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0))[0];

      const userId = req.user?.id;
      const money = await getUserMoneySettings(userId);
      const { bets } = await readBets(userId, money);
      const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
      const W = settled.filter(b => b.uitkomst === 'W').length;
      const L = settled.filter(b => b.uitkomst === 'L').length;
      const P = 0;
      const profitU = +(settled.reduce((s, b) => s + (b.wl || 0), 0) / money.unitEur).toFixed(1);
      const profitStr = profitU >= 0 ? `+${profitU}U` : `${profitU}U`;

      const last5 = settled.slice(-5).map(b => b.uitkomst === 'W' ? '✅' : '❌').join('');
      const last5Short = settled.slice(-5).map(b => b.uitkomst === 'W' ? 'W' : 'L').join('-');

      const lastBet = settled[settled.length - 1];
      const lastResult = lastBet
        ? `${lastBet.uitkomst === 'W' ? '✅' : '❌'} ${lastBet.wedstrijd} ${lastBet.uitkomst === 'W' ? '(W)' : '(L)'}`
        : 'Geen vorige pick';

      const match = pick.match || '';
      const odds = pick.odd || pick.odds || 0;
      const units = pick.units || 0;
      const prob = pick.prob || 0;
      const edge = pick.edge || 0;
      const fairProb = prob;
      const impliedProb = odds > 1 ? (1 / odds * 100) : 0;
      const kickoff = pick.kickoff || '';
      const referee = pick.referee || '';

      const today = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Amsterdam' }).replace(/\//g, '-');

      const reddit = [
        `**Pick of the Day (${today})** 🎯 🔥`,
        `**Record (W-L-P):** ${W}-${L}-${P} **${profitStr}**`,
        `**Last 5:** ${last5}`,
        '',
        lastBet ? `**Last Pick:** ${lastResult}` : '',
        '',
        `**${match}**`,
        `🕐 ${kickoff} (Amsterdam time)`,
        `💰 Odds: ${odds}`,
        `💵 Stake: ${units}U`,
        '',
        `*${pick.reason || ''}*`,
        '',
        `**Technical info:**`,
        `Edge on bookie +${edge.toFixed(1)}% · Consensus: ${impliedProb.toFixed(1)}%→${fairProb.toFixed(1)}%${referee ? ` | 🟨 ${referee}` : ''}`,
        '',
        `#PickOfTheDay #SportsBetting #SoccerBetting #potd #ValueBet`,
      ].filter(l => l !== undefined).join('\n');

      const x = [
        `🔥 Pick of the Day (${today})`,
        '',
        `Record: ${W}-${L}-${P} (${profitStr}) | Last 5: ${last5Short}`,
        '',
        `⚽ ${match}`,
        `🕐 ${kickoff} (Amsterdam) | 💰 Stake: ${units}U`,
        `📊 Odds: ${odds}`,
        '',
        `📊 Model edge: +${edge.toFixed(1)}% EV (${impliedProb.toFixed(1)}% → ${fairProb.toFixed(1)}%)`,
        '',
        `#PickOfTheDay #SportsBetting #SoccerBetting #potd #ValueBet`,
      ].join('\n');

      res.json({ pick, reddit, x, record: { W, L, P, profitU, last5 } });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.post('/analyze', async (req, res) => {
    try {
      if (rateLimit('analyze:' + req.user?.id, 10, 60 * 1000)) return res.status(429).json({ error: 'Te veel analyse-requests · wacht een minuut' });
      const query = (req.body?.query || '').trim();
      if (!query.length || query.length > 500) return res.status(400).json({ error: 'Query ongeldig of te lang (max 500 chars)' });

      let teamA = null, teamB = null, market = null;

      const speeltMatch = query.match(/speelt\s+(.+?)\s+tegen\s+(.+?)(?:[\s,\.!?]|$)/i);
      const tegenMatch = query.match(/^(?:vanavond|morgen|vandaag|straks)?\s*(.+?)\s+tegen\s+(.+?)(?:[\s,\.!?]|$)/i);
      const vsMatch = query.match(/(.+?)\s+(?:vs\.?|[-–])\s+(.+)/i);
      const simpleMatch = query.match(/^([A-Z][\w]+(?:\s+[A-Z][\w]+)?)\s+([A-Z][\w]+(?:\s+[A-Z][\w]+)?)/);

      if (speeltMatch)      { teamA = speeltMatch[1].trim();  teamB = speeltMatch[2].trim(); }
      else if (tegenMatch)  { teamA = tegenMatch[1].trim();   teamB = tegenMatch[2].trim(); }
      else if (vsMatch)     { teamA = vsMatch[1].trim();      teamB = vsMatch[2].trim(); }
      else if (simpleMatch) { teamA = simpleMatch[1].trim();  teamB = simpleMatch[2].trim(); }

      const fillerWords = /^(vanavond|morgen|vandaag|straks|ik\s+denk\s+dat|misschien|volgens\s+mij|jij\??)\s*/gi;
      if (teamA) teamA = teamA.replace(fillerWords, '').trim();
      if (teamB) teamB = teamB.replace(fillerWords, '').replace(/[\s,\.!?]+$/, '').trim();

      const wintMatch  = query.match(/(\w+)\s+wint/i);
      const overMatch  = query.match(/over\s*([\d.]+)/i);
      const underMatch = query.match(/under\s*([\d.]+)/i);
      const bttsMatch  = query.match(/btts|beide\s+teams?\s+scoren/i);
      const gelijkMatch = query.match(/gelijkspel|gelijk|draw/i);

      if (overMatch) market = `Over ${overMatch[1]}`;
      else if (underMatch) market = `Under ${underMatch[1]}`;
      else if (bttsMatch) market = 'BTTS';
      else if (gelijkMatch) market = 'Gelijkspel';
      else if (wintMatch) market = `${wintMatch[1]} wint`;

      if (!teamA) {
        const words = query.replace(fillerWords, '').replace(/[,\.!?]+/g, '').trim();
        if (words.length < 2) return res.status(400).json({ error: 'Kon geen teams herkennen. Probeer: "Ajax vs PSV" of "Ajax PSV over 2.5"' });
        teamA = words;
      }

      const searchTerms = [teamA, teamB].filter(Boolean).map(t => t.toLowerCase());
      const allPicks = [...getLastPrematchPicks()];

      try {
        const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
        if (history && history.length) {
          for (const entry of history) {
            if (entry.picks) allPicks.push(...entry.picks);
          }
        }
      } catch (e) {
        console.warn('Scan history load failed:', e.message);
      }

      let userBookiesLc = null;
      try {
        const users = await loadUsers().catch(() => []);
        const me = users.find(u => u.id === req.user?.id);
        const list = me?.settings?.preferredBookies;
        if (Array.isArray(list) && list.length) {
          userBookiesLc = list.map(b => (b || '').toString().toLowerCase()).filter(Boolean);
        }
      } catch {}

      const rawMatches = allPicks.filter(p => {
        const matchStr = (p.match || '').toLowerCase();
        return searchTerms.some(t => matchStr.includes(t));
      });
      const inPrefs = (p) => !userBookiesLc
        || userBookiesLc.some(b => (p.bookie || '').toLowerCase().includes(b));
      const matchesPref = rawMatches.filter(inPrefs);
      const matchesNonPref = rawMatches.filter(p => !inPrefs(p));
      const matches = matchesPref.length ? matchesPref : [];
      const nonPrefWarning = (!matchesPref.length && matchesNonPref.length)
        ? {
            warning: `Pick gevonden, maar niet bij jouw bookies (${(userBookiesLc || []).join(', ')}). Beschikbaar bij: ${Array.from(new Set(matchesNonPref.map(p => p.bookie).filter(Boolean))).join(', ') || 'onbekend'}.`,
            matches: matchesNonPref,
          }
        : null;

      if (!matches.length) {
        if (nonPrefWarning) {
          const projected = nonPrefWarning.matches.slice(0, 5).map(p => {
            const score = p.score || (p.kelly ? Math.min(10, Math.max(5, Math.round((p.kelly - 0.015) / 0.135 * 5) + 5)) : null);
            return {
              match: p.match, league: p.league, label: p.label, odd: p.odd,
              prob: p.prob, units: p.units, edge: p.edge, score,
              kickoff: p.kickoff, bookie: p.bookie, sport: p.sport || 'football',
              warning: nonPrefWarning.warning,
            };
          });
          if (projected.length === 1) return res.json(projected[0]);
          return res.json({ multi: true, results: projected, warning: nonPrefWarning.warning });
        }
        const now = Date.now();
        const dateRange = [-1, 0, 1].map(o => new Date(now + o * 86400000)
          .toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }));
        let foundFixtures = [];
        const liveStatuses = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT', 'LIVE', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'];
        const qLc = query.toLowerCase();

        const sportHints = [
          { sport: 'hockey',             re: /\b(hockey|nhl|ijshockey|ice hockey)\b/i },
          { sport: 'basketball',         re: /\b(basketball|basketbal|nba|ncaa)\b/i },
          { sport: 'baseball',           re: /\b(baseball|honkbal|mlb)\b/i },
          { sport: 'american-football',  re: /\b(nfl|american football|amerikaans voetbal)\b/i },
          { sport: 'handball',           re: /\b(handbal|handball)\b/i },
          { sport: 'football',           re: /\b(voetbal|soccer|football)\b/i },
        ];
        const matched = sportHints.find(h => h.re.test(qLc));
        const trySports = matched
          ? [matched.sport]
          : ['football', 'basketball', 'hockey', 'baseball', 'american-football', 'handball'];

        async function searchSport(sport) {
          const cfg = getSportApiConfig(sport);
          const seen = new Set();
          const pool = [];
          for (const d of dateRange) {
            const games = await afGet(cfg.host, cfg.fixturesPath, { date: d }).catch(() => []);
            for (const g of (games || [])) {
              const gid = sport === 'football' ? g.fixture?.id : g.id;
              if (gid == null || seen.has(gid)) continue;
              seen.add(gid);
              pool.push(g);
            }
          }
          const scored = [];
          for (const f of pool) {
            const status = sport === 'football' ? f.fixture?.status?.short : f.status?.short;
            if (liveStatuses.includes(status)) continue;
            const home = f.teams?.home?.name || '';
            const away = f.teams?.away?.name || '';
            const hs = teamA ? teamMatchScore(home, teamA) : 0;
            const as = teamB ? teamMatchScore(away, teamB) : 0;
            const anyA = teamA ? Math.max(teamMatchScore(home, teamA), teamMatchScore(away, teamA)) : 0;
            const anyB = teamB ? Math.max(teamMatchScore(home, teamB), teamMatchScore(away, teamB)) : 0;
            const score = teamB ? (hs + as) : anyA;
            const pass  = teamB ? (score >= 70 && anyA >= 40 && anyB >= 40) : (anyA >= 60);
            if (!pass) continue;
            const kickoffIso = sport === 'football' ? f.fixture?.date : (f.date || f.time);
            scored.push({
              score,
              match: `${home} vs ${away}`,
              league: f.league?.name || '',
              kickoff: kickoffIso
                ? new Date(kickoffIso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
                : '',
              sport,
            });
          }
          scored.sort((a, b) => b.score - a.score);
          return scored;
        }

        try {
          let all = [];
          let extraCalls = 0;
          for (const sport of trySports) {
            if (extraCalls >= 3) break;
            const found = await searchSport(sport).catch(() => []);
            if (found.length) all.push(...found);
            if (!matched && sport !== 'football') extraCalls++;
            if (!matched && all.length >= 5) break;
          }
          const dedupe = new Map();
          for (const f of all) {
            const key = `${f.sport}|${f.match}`;
            if (!dedupe.has(key) || dedupe.get(key).score < f.score) dedupe.set(key, f);
          }
          foundFixtures = Array.from(dedupe.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(({ score, ...rest }) => rest);
        } catch {}

        return res.json({
          error: `Geen analyse beschikbaar voor "${query}". Start een scan om deze wedstrijd te analyseren.`,
          matches: foundFixtures,
          foundFixtures,
        });
      }

      const liveStatuses = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT', 'LIVE'];
      try {
        const bestMatchName = matches[0]?.match || '';
        const bestSport = matches[0]?.sport || 'football';
        if (bestSport === 'football' && bestMatchName) {
          const todayIso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
          const fxList = await afGet('v3.football.api-sports.io', '/fixtures', { date: todayIso }).catch(() => []);
          const [qHome, qAway] = bestMatchName.split(' vs ').map(s => s.trim());
          const hit = (fxList || []).find(f => {
            const sHome = teamMatchScore(f.teams?.home?.name || '', qHome);
            const sAway = teamMatchScore(f.teams?.away?.name || '', qAway);
            return sHome >= 60 && sAway >= 60;
          });
          const status = hit?.fixture?.status?.short;
          if (status && liveStatuses.includes(status)) {
            return res.json({ error: 'Wedstrijd is al bezig. Pre-match analyse niet mogelijk.' });
          }
        }
      } catch (e) {
        console.warn('Analyze: live-status check failed:', e.message);
      }

      const isAdmin = req.user?.role === 'admin';
      const projectPick = (p) => {
        const score = p.score || (p.kelly ? Math.min(10, Math.max(5, Math.round((p.kelly - 0.015) / 0.135 * 5) + 5)) : null);
        const base = {
          match: p.match, league: p.league, label: p.label, odd: p.odd,
          prob: p.prob, units: p.units, edge: p.edge, score,
          kickoff: p.kickoff, bookie: p.bookie, sport: p.sport || 'football',
        };
        if (isAdmin) {
          base.reason = p.reason;
          base.signals = p.signals;
          if (p.kelly !== undefined) base.kelly = p.kelly;
          if (p.ep !== undefined) base.ep = p.ep;
          if (p.expectedEur !== undefined) base.expectedEur = p.expectedEur;
        }
        return base;
      };

      if (market) {
        const marketLc = market.toLowerCase();
        const marketMatches = matches.filter(p => (p.label || '').toLowerCase().includes(marketLc.split(' ')[0]));
        if (marketMatches.length) return res.json(projectPick(marketMatches[0]));
      }

      if (matches.length === 1) return res.json(projectPick(matches[0]));

      return res.json({ multi: true, results: matches.map(projectPick) });
    } catch (e) {
      console.error('Analyze error:', e.message);
      res.status(500).json({ error: 'Analyse mislukt' });
    }
  });

  return router;
};
