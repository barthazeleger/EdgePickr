'use strict';

const express = require('express');
const { isV1LiveStatus, shouldIncludeDatedV1Game } = require('../runtime/live-board');

/**
 * v11.3.12 · Phase 5.4t: Live scoreboard routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createLiveRouter({...}))`.
 *
 * Endpoints:
 *   - GET /api/live-poll         — ESPN scoreboard (gratis, snelle poll, alleen football)
 *   - GET /api/live-scores       — api-football live+today voor 6 sporten, gededupeerd
 *   - GET /api/live-events/:id   — per-fixture events + stats + xG-schatting (football)
 *
 * @param {object} deps
 *   - afGet            — async (host, path, params) → any
 *   - leagues          — { football, basketball, hockey, baseball, american-football, handball } each [{id,name}]
 * @returns {express.Router}
 */
module.exports = function createLiveRouter(deps) {
  const { afGet, leagues } = deps;

  const required = { afGet, leagues };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createLiveRouter: missing required dep '${key}'`);
    }
  }

  const AF_FOOTBALL_LEAGUES = leagues.football  || [];
  const NBA_LEAGUES         = leagues.basketball || [];
  const NHL_LEAGUES         = leagues.hockey    || [];
  const BASEBALL_LEAGUES    = leagues.baseball  || [];
  const NFL_LEAGUES         = leagues['american-football'] || [];
  const HANDBALL_LEAGUES    = leagues.handball  || [];

  const router = express.Router();

  router.get('/live-poll', async (req, res) => {
    try {
      const espnGet = url => fetch(url, { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => ({}));
      const espnLeagues = [
        'eng.1','eng.2','esp.1','ger.1','ita.1','fra.1','ned.1','por.1','tur.1',
        'uefa.champions','uefa.europa','bel.1','sco.1'
      ];
      const raw = await Promise.all(espnLeagues.map(async code => {
        const d = await espnGet(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard`);
        return (d.events || []).map(ev => {
          const comp = ev.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === 'home');
          const away = comp?.competitors?.find(c => c.homeAway === 'away');
          const status = ev.status?.type;
          const clock = ev.status?.displayClock || '';
          const detail = status?.shortDetail || '';
          const isLive = status?.state === 'in' || detail.match(/^(1st|2nd|HT|Half|ET)/i);
          const isFT = status?.completed || false;
          if (!home || !away) return null;
          return {
            id: ev.id, home: home.team?.displayName||'', away: away.team?.displayName||'',
            homeLogo: home.team?.logo||'', awayLogo: away.team?.logo||'',
            scoreH: parseInt(home.score||'0'), scoreA: parseInt(away.score||'0'),
            minute: isLive ? (detail.match(/^(HT|Half)/i) ? 'HT' : clock.replace(/\s/g,'')+"'") : isFT ? 'FT' : '',
            live: isLive, finished: isFT,
            league: ev.season?.type?.name || code,
            startTime: new Date(ev.date).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' }),
          };
        }).filter(Boolean);
      }));
      const events = raw.flat();
      res.json({ events, liveCount: events.filter(e => e.live).length, ts: Date.now() });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/live-scores', async (req, res) => {
    try {
      const knownLeagueIds = new Set(AF_FOOTBALL_LEAGUES.map(l => l.id));
      const leagueNames    = Object.fromEntries(AF_FOOTBALL_LEAGUES.map(l => [l.id, l.name]));

      const knownBBLeagueIds  = new Set(NBA_LEAGUES.map(l => l.id));
      const bbLeagueNames     = Object.fromEntries(NBA_LEAGUES.map(l => [l.id, l.name]));
      const knownHKLeagueIds  = new Set(NHL_LEAGUES.map(l => l.id));
      const hkLeagueNames     = Object.fromEntries(NHL_LEAGUES.map(l => [l.id, l.name]));
      const knownBALeagueIds  = new Set(BASEBALL_LEAGUES.map(l => l.id));
      const baLeagueNames     = Object.fromEntries(BASEBALL_LEAGUES.map(l => [l.id, l.name]));
      const knownNFLLeagueIds = new Set(NFL_LEAGUES.map(l => l.id));
      const nflLeagueNames    = Object.fromEntries(NFL_LEAGUES.map(l => [l.id, l.name]));
      const knownHBLeagueIds  = new Set(HANDBALL_LEAGUES.map(l => l.id));
      const hbLeagueNames     = Object.fromEntries(HANDBALL_LEAGUES.map(l => [l.id, l.name]));

      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      const [
        liveFixtures, todayFixtures,
        bbLive, bbToday,
        hkLive, hkToday,
        baLive, baToday, baYesterday,
        nflLive, nflToday,
        hbLive, hbToday,
      ] = await Promise.all([
        afGet('v3.football.api-sports.io', '/fixtures', { live: 'all' }).catch(() => []),
        afGet('v3.football.api-sports.io', '/fixtures', { date: today }).catch(() => []),
        afGet('v1.basketball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
        afGet('v1.basketball.api-sports.io', '/games', { date: today }).catch(() => []),
        afGet('v1.hockey.api-sports.io', '/games', { live: 'all' }).catch(() => []),
        afGet('v1.hockey.api-sports.io', '/games', { date: today }).catch(() => []),
        afGet('v1.baseball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
        afGet('v1.baseball.api-sports.io', '/games', { date: today }).catch(() => []),
        afGet('v1.baseball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
        afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
        afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
        afGet('v1.handball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
        afGet('v1.handball.api-sports.io', '/games', { date: today }).catch(() => []),
      ]);

      const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);

      const mapFixture = (f) => {
        const statusShort = f.fixture?.status?.short || '';
        const elapsed     = f.fixture?.status?.elapsed;
        const extra       = f.fixture?.status?.extra;
        const isLive      = LIVE_STATUSES.has(statusShort);

        let minute = '';
        if (isLive) {
          if (statusShort === 'HT') minute = 'HT';
          else if (statusShort === 'BT') minute = 'ET rust';
          else if (elapsed != null) minute = extra ? `${elapsed}+${extra}'` : `${elapsed}'`;
        }

        const startTime = !isLive && f.fixture?.date
          ? new Date(f.fixture.date).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' })
          : '';

        return {
          id:        f.fixture.id,
          fixtureId: f.fixture.id,
          sport:     'football',
          league:    leagueNames[f.league?.id] || f.league?.name || '',
          leagueId:  f.league?.id,
          home:      f.teams?.home?.name || '?',
          away:      f.teams?.away?.name || '?',
          homeLogo:  f.teams?.home?.logo || '',
          awayLogo:  f.teams?.away?.logo || '',
          scoreH:    isLive ? (f.goals?.home ?? 0) : null,
          scoreA:    isLive ? (f.goals?.away ?? 0) : null,
          minute,
          status:    f.fixture?.status?.long || '',
          startTime,
          live:      isLive,
        };
      };

      const mapV1Game = (g, sport, leagueNamesMap) => {
        const statusShort = (g.status?.short || g.game?.status?.short || '').toUpperCase();
        const isLive = isV1LiveStatus(statusShort);
        const isFT = statusShort === 'FT' || statusShort === 'AOT' || statusShort === 'AP';

        let scoreH = null, scoreA = null;
        if (sport === 'basketball' || sport === 'baseball') {
          scoreH = isLive || isFT ? (g.scores?.home?.total ?? 0) : null;
          scoreA = isLive || isFT ? (g.scores?.away?.total ?? 0) : null;
        } else if (sport === 'hockey' || sport === 'handball') {
          scoreH = isLive || isFT ? (g.scores?.home ?? 0) : null;
          scoreA = isLive || isFT ? (g.scores?.away ?? 0) : null;
        } else if (sport === 'american-football') {
          scoreH = isLive || isFT ? (g.scores?.home?.total ?? 0) : null;
          scoreA = isLive || isFT ? (g.scores?.away?.total ?? 0) : null;
        }

        const leagueId = g.league?.id;
        const startDate = g.date || g.game?.date?.date;
        const startTime = !isLive && startDate
          ? new Date(startDate).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' })
          : '';

        return {
          id:        g.id || g.game?.id || 0,
          fixtureId: g.id || g.game?.id || 0,
          sport,
          league:    leagueNamesMap[leagueId] || g.league?.name || '',
          leagueId,
          home:      g.teams?.home?.name || '?',
          away:      g.teams?.away?.name || '?',
          homeLogo:  g.teams?.home?.logo || '',
          awayLogo:  g.teams?.away?.logo || '',
          scoreH,
          scoreA,
          minute:    isLive ? statusShort : isFT ? 'FT' : '',
          status:    g.status?.long || g.game?.status?.long || '',
          startTime,
          live:      isLive,
        };
      };

      const seen = new Set();
      const events = [];

      for (const f of (liveFixtures || [])) {
        if (!knownLeagueIds.has(f.league?.id)) continue;
        seen.add(f.fixture?.id);
        events.push(mapFixture(f));
      }
      for (const f of (todayFixtures || [])) {
        if (!knownLeagueIds.has(f.league?.id)) continue;
        if (seen.has(f.fixture?.id)) continue;
        if (f.fixture?.status?.short !== 'NS') continue;
        seen.add(f.fixture?.id);
        events.push(mapFixture(f));
      }

      const addV1Sport = (liveGames, datedGames, sport, knownIds, namesMap, options = {}) => {
        const sportSeen = new Set();
        for (const g of (liveGames || [])) {
          const lid = g.league?.id;
          const gid = g.id || g.game?.id;
          if (!knownIds.has(lid)) continue;
          sportSeen.add(gid);
          events.push(mapV1Game(g, sport, namesMap));
        }
        for (const g of (datedGames || [])) {
          const lid = g.league?.id;
          const gid = g.id || g.game?.id;
          if (!knownIds.has(lid)) continue;
          if (sportSeen.has(gid)) continue;
          const st = (g.status?.short || g.game?.status?.short || '').toUpperCase();
          if (!shouldIncludeDatedV1Game(st, options)) continue;
          sportSeen.add(gid);
          events.push(mapV1Game(g, sport, namesMap));
        }
      };

      addV1Sport(bbLive,  bbToday,  'basketball',       knownBBLeagueIds,  bbLeagueNames);
      addV1Sport(hkLive,  hkToday,  'hockey',           knownHKLeagueIds,  hkLeagueNames);
      addV1Sport(baLive,  [...(baToday || []), ...(baYesterday || [])], 'baseball', knownBALeagueIds, baLeagueNames, { includeLiveStatuses: true });
      addV1Sport(nflLive, nflToday, 'american-football', knownNFLLeagueIds, nflLeagueNames);
      addV1Sport(hbLive,  hbToday,  'handball',         knownHBLeagueIds,  hbLeagueNames);

      events.sort((a, b) => {
        if (a.live !== b.live) return b.live ? 1 : -1;
        return (a.startTime || '').localeCompare(b.startTime || '');
      });

      res.json({ events, liveCount: events.filter(e => e.live).length });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/live-events/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });

      const [eventsData, statsData, fixtureData] = await Promise.all([
        afGet('v3.football.api-sports.io', '/fixtures/events',     { fixture: id }),
        afGet('v3.football.api-sports.io', '/fixtures/statistics', { fixture: id }),
        afGet('v3.football.api-sports.io', '/fixtures',            { id }),
      ]);

      const events = (eventsData || []).map(ev => {
        const t = ev.type || '', detail = ev.detail || '';
        let type;
        if (t === 'Goal') {
          type = detail.includes('Own Goal') ? 'owngoal' : 'goal';
        } else if (t === 'Card') {
          type = detail.includes('Yellow') ? 'yellow' : 'red';
        } else if (t === 'subst') {
          type = 'sub';
        } else { return null; }

        const min = ev.time?.elapsed != null
          ? (ev.time?.extra ? `${ev.time.elapsed}+${ev.time.extra}'` : `${ev.time.elapsed}'`)
          : '';
        return {
          type,
          minute:  min,
          team:    ev.team?.name   || '',
          player:  ev.player?.name || '',
          assist:  ev.assist?.name || '',
          detail,
        };
      }).filter(Boolean);

      const fx     = fixtureData?.[0];
      const homeT  = fx?.teams?.home?.name  || '';
      const awayT  = fx?.teams?.away?.name  || '';
      const scoreH = fx?.goals?.home ?? null;
      const scoreA = fx?.goals?.away ?? null;
      const short  = fx?.fixture?.status?.short || '';
      const elapsed = fx?.fixture?.status?.elapsed;
      const extra   = fx?.fixture?.status?.extra;
      const minute  = short === 'HT' ? 'HT' : elapsed != null
        ? (extra ? `${elapsed}+${extra}'` : `${elapsed}'`) : '';
      const status = fx?.fixture?.status?.long || '';

      const homeId = fx?.teams?.home?.id;
      const statMap = {};
      for (const side of (statsData || [])) {
        const isHome = side.team?.id === homeId;
        for (const s of (side.statistics || [])) {
          if (!statMap[s.type]) statMap[s.type] = {};
          statMap[s.type][isHome ? 'home' : 'away'] = s.value ?? '—';
        }
      }

      const statKeyMap = [
        ['Ball Possession',   'possessionPct'],
        ['Shots on Goal',     'shotsOnTarget'],
        ['Blocked Shots',     'blockedShots'],
        ['Corner Kicks',      'wonCorners'],
        ['Fouls',             'foulsCommitted'],
        ['Yellow Cards',      'yellowCards'],
        ['Red Cards',         'redCards'],
        ['Offsides',          'offsides'],
        ['Goalkeeper Saves',  'saves'],
      ];
      const stats = statKeyMap
        .filter(([k]) => statMap[k])
        .map(([k, key]) => ({ key, home: statMap[k]?.home ?? '—', away: statMap[k]?.away ?? '—' }));

      if (statMap['expected_goals'] || statMap['Expected Goals'] || statMap['xG']) {
        const xgKey = statMap['expected_goals'] ? 'expected_goals' : statMap['xG'] ? 'xG' : 'Expected Goals';
        stats.unshift({ key: 'xG', home: statMap[xgKey]?.home ?? '—', away: statMap[xgKey]?.away ?? '—' });
      } else if (statMap['Shots on Goal']) {
        const sotH2 = parseFloat(statMap['Shots on Goal']?.home) || 0;
        const sotA2 = parseFloat(statMap['Shots on Goal']?.away) || 0;
        if (sotH2 || sotA2) stats.unshift({ key: 'xG', home: (sotH2*0.33).toFixed(2), away: (sotA2*0.33).toFixed(2) });
      }

      res.json({ events, home: homeT, away: awayT, scoreH, scoreA, status, minute, stats });
    } catch (e) { res.status(500).json({ error: 'Interne fout', events: [] }); }
  });

  return router;
};
