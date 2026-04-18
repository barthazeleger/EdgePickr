'use strict';

const { resolveBetOutcome } = require('./results-checker');
const { isV1LiveStatus } = require('./live-board');
const { logEarlyPayoutShadow } = require('../signals/early-payout');
const { marketKeyFromBetMarkt } = require('../clv-match');

/**
 * v11.3.17 · Phase 5.4y: checkOpenBetResults factory.
 *
 * Haalt finished + live fixtures over 6 sporten (today + yesterday) via
 * api-sports, matcht ze tegen open bets en roept `resolveBetOutcome` aan.
 * Settled bets worden via `updateBetOutcome` weggeschreven, operator krijgt
 * een web-push notification, en moneyline-settles schrijven een early-payout
 * shadow-log voor latere promotie-analyse.
 *
 * @param {object} deps
 *   - supabase
 *   - readBets            — async (userId) → { bets }
 *   - updateBetOutcome    — async (id, uitkomst, userId) → void
 *   - afGet               — async (host, path, params) → any
 *   - sendPushToUser      — async (userId, payload) → void
 * @returns {function} async (userId?) → { checked, updated, results }
 */
module.exports = function createOpenBetsChecker(deps) {
  const { supabase, readBets, updateBetOutcome, afGet, sendPushToUser } = deps;

  const required = { supabase, readBets, updateBetOutcome, afGet, sendPushToUser };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createOpenBetsChecker: missing required dep '${key}'`);
    }
  }

  return async function checkOpenBetResults(userId = null) {
    const { bets } = await readBets(userId);
    const openBets = bets.filter(b => b.uitkomst === 'Open');
    if (!openBets.length) return { checked: 0, updated: 0, results: [] };

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

    const [
      todayFixtures, yesterdayFixtures,
      bbToday, bbYesterday,
      hkToday, hkYesterday,
      baToday, baYesterday,
      nflToday, nflYesterday,
      hbToday, hbYesterday,
    ] = await Promise.all([
      afGet('v3.football.api-sports.io', '/fixtures', { date: today }).catch(() => []),
      afGet('v3.football.api-sports.io', '/fixtures', { date: yesterday }).catch(() => []),
      afGet('v1.basketball.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.basketball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
      afGet('v1.hockey.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.hockey.api-sports.io', '/games', { date: yesterday }).catch(() => []),
      afGet('v1.baseball.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.baseball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: yesterday }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
    ]);

    const FINISHED_STATUSES = new Set(['FT','AET','PEN']);
    const FOOTBALL_LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);
    const footballFinished = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
      .filter(f => FINISHED_STATUSES.has(f.fixture?.status?.short))
      .map(f => ({
        home:   f.teams?.home?.name || '',
        away:   f.teams?.away?.name || '',
        scoreH: f.goals?.home ?? 0,
        scoreA: f.goals?.away ?? 0,
        sport:  'football',
      }));
    const footballCurrent = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
      .filter(f => FOOTBALL_LIVE_STATUSES.has(f.fixture?.status?.short))
      .map(f => ({
        home:   f.teams?.home?.name || '',
        away:   f.teams?.away?.name || '',
        scoreH: f.goals?.home ?? 0,
        scoreA: f.goals?.away ?? 0,
        sport:  'football',
        live:   true,
      }));

    const bbFinished = [...(bbToday || []), ...(bbYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return status === 'FT' || status === 'AOT';
    }).map(g => ({
      home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
      halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
      halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
      sport: 'basketball',
    }));
    const bbCurrent = [...(bbToday || []), ...(bbYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return isV1LiveStatus(status);
    }).map(g => ({
      home: g.teams?.home?.name || '',
      away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      sport: 'basketball',
      live: true,
    }));

    const hkFinished = [...(hkToday || []), ...(hkYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return status === 'FT' || status === 'AOT' || status === 'AP';
    }).map(g => {
      const status = (g.status?.short || '').toUpperCase();
      const p1H = g.periods?.first?.home ?? null;
      const p1A = g.periods?.first?.away ?? null;
      const p2H = g.periods?.second?.home ?? null;
      const p2A = g.periods?.second?.away ?? null;
      const p3H = g.periods?.third?.home ?? null;
      const p3A = g.periods?.third?.away ?? null;
      let regH, regA;
      if (p1H != null && p2H != null && p3H != null) {
        regH = p1H + p2H + p3H;
        regA = (p1A || 0) + (p2A || 0) + (p3A || 0);
      } else if (status === 'FT') {
        regH = g.scores?.home ?? 0;
        regA = g.scores?.away ?? 0;
      } else if (status === 'AOT' || status === 'AP') {
        regH = regA = g.scores?.home ?? 0;
      } else {
        regH = g.scores?.home ?? 0;
        regA = g.scores?.away ?? 0;
      }
      return {
        home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
        scoreH: g.scores?.home ?? 0, scoreA: g.scores?.away ?? 0,
        regScoreH: regH, regScoreA: regA,
        status,
        p1H, p1A,
        sport: 'hockey',
      };
    });
    const hkCurrent = [...(hkToday || []), ...(hkYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return isV1LiveStatus(status);
    }).map(g => ({
      home: g.teams?.home?.name || '',
      away: g.teams?.away?.name || '',
      scoreH: g.scores?.home ?? 0,
      scoreA: g.scores?.away ?? 0,
      sport: 'hockey',
      live: true,
    }));

    const baseballFinished = [...(baToday || []), ...(baYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return status === 'FT' || status === 'AOT';
    }).map(g => ({
      home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
      inn1H: g.scores?.home?.innings?.['1'] ?? g.scores?.home?.inning_1 ?? null,
      inn1A: g.scores?.away?.innings?.['1'] ?? g.scores?.away?.inning_1 ?? null,
      sport: 'baseball',
    }));
    const baseballCurrent = [...(baToday || []), ...(baYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return isV1LiveStatus(status);
    }).map(g => ({
      home: g.teams?.home?.name || '',
      away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      inn1H: g.scores?.home?.innings?.['1'] ?? g.scores?.home?.inning_1 ?? null,
      inn1A: g.scores?.away?.innings?.['1'] ?? g.scores?.away?.inning_1 ?? null,
      sport: 'baseball',
      live: true,
    }));

    const nflFinished = [...(nflToday || []), ...(nflYesterday || [])].filter(g => {
      const status = (g.game?.status?.short || '').toUpperCase();
      return status === 'FT' || status === 'AOT';
    }).map(g => ({
      home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
      halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
      halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
      sport: 'american-football',
    }));
    const nflCurrent = [...(nflToday || []), ...(nflYesterday || [])].filter(g => {
      const status = (g.game?.status?.short || '').toUpperCase();
      return isV1LiveStatus(status);
    }).map(g => ({
      home: g.teams?.home?.name || '',
      away: g.teams?.away?.name || '',
      scoreH: g.scores?.home?.total ?? 0,
      scoreA: g.scores?.away?.total ?? 0,
      sport: 'american-football',
      live: true,
    }));

    const handballFinished = [...(hbToday || []), ...(hbYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return status === 'FT' || status === 'AOT' || status === 'AP';
    }).map(g => {
      const status = (g.status?.short || '').toUpperCase();
      const scoreH = g.scores?.home ?? 0;
      const scoreA = g.scores?.away ?? 0;
      let regH = scoreH, regA = scoreA;
      if (status === 'AOT' || status === 'AP') { regH = regA = scoreH; }
      return { home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
               scoreH, scoreA, regScoreH: regH, regScoreA: regA, status, sport: 'handball' };
    });

    const allFinished = [...footballFinished, ...bbFinished, ...hkFinished, ...baseballFinished, ...nflFinished, ...handballFinished];
    const handballCurrent = [...(hbToday || []), ...(hbYesterday || [])].filter(g => {
      const status = (g.status?.short || '').toUpperCase();
      return isV1LiveStatus(status);
    }).map(g => ({
      home: g.teams?.home?.name || '',
      away: g.teams?.away?.name || '',
      scoreH: g.scores?.home ?? 0,
      scoreA: g.scores?.away ?? 0,
      sport: 'handball',
      live: true,
    }));

    const allCurrent = [...footballCurrent, ...bbCurrent, ...hkCurrent, ...baseballCurrent, ...nflCurrent, ...handballCurrent];
    const matchEventForBet = (events, hmQ, awQ) => events.find(e => {
      const h = e.home.toLowerCase(), a = e.away.toLowerCase();
      return (h.includes(hmQ) || hmQ.includes(h.split(' ').pop())) &&
             (a.includes(awQ) || awQ.includes(a.split(' ').pop()));
    });

    const results = [];
    for (const bet of openBets) {
      const parts = (bet.wedstrijd||'').split(' vs ').map(s => s.trim().toLowerCase());
      if (parts.length < 2) continue;
      const [hmQ, awQ] = parts;
      const finishedEv = matchEventForBet(allFinished, hmQ, awQ);
      const liveEv = finishedEv ? null : matchEventForBet(allCurrent, hmQ, awQ);
      const ev = finishedEv || liveEv;
      if (!ev) continue;

      const { uitkomst, note } = resolveBetOutcome(bet.markt, ev, { isLive: !finishedEv });

      if (uitkomst) {
        await updateBetOutcome(bet.id, uitkomst, userId);
        const wlAmount = uitkomst === 'W' ? +((bet.odds-1)*bet.inzet).toFixed(2) : -bet.inzet;
        await sendPushToUser(userId, {
          title: uitkomst === 'W' ? '✅ Bet gewonnen!' : '❌ Bet verloren',
          body: `${bet.wedstrijd}: ${ev.scoreH}-${ev.scoreA}\n${bet.markt} · ${uitkomst === 'W' ? '+' : ''}€${wlAmount}`,
          tag: 'bet-result-' + bet.id,
          url: '/',
        }).catch(e => console.warn(`[bet-push] failed voor bet ${bet.id}:`, e?.message || e));

        try {
          const mk = marketKeyFromBetMarkt(bet.markt);
          if (mk && mk.market_type === 'moneyline' && bet.tip) {
            await logEarlyPayoutShadow(supabase, {
              betId: bet.id,
              bookie: bet.tip,
              sport: bet.sport || 'football',
              marketType: mk.market_type,
              selection: mk.selection_key,
              actualOutcome: uitkomst,
              finalScoreHome: ev.scoreH,
              finalScoreAway: ev.scoreA,
              oddsUsed: bet.odds,
            });
          }
        } catch (e) {
          console.warn(`[early-payout] shadow-log skip voor bet ${bet.id}:`, e?.message || e);
        }
      }
      results.push({
        id: bet.id, wedstrijd: bet.wedstrijd, markt: bet.markt,
        score: `${ev.scoreH}-${ev.scoreA}`, uitkomst,
        note: uitkomst ? null : (note || 'Score gevonden · update handmatig'),
      });
    }

    return { checked: openBets.length, updated: results.filter(r => r.uitkomst).length, results };
  };
};
