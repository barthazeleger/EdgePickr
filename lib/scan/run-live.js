'use strict';

const { convertAfOdds } = require('../odds-parser');

const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));

/**
 * v11.3.17 · Phase 6.1: Live scan (getLivePicks + runLive) extracted uit server.js.
 *
 * Factory pattern. Roep `createLiveScan({...})` en gebruik de `runLive` return.
 *
 * Live-scan scenarios (football only — live odds zijn NL-licensed only
 * betrouwbaar in football):
 *   1. xG-dominantie vs score → value op dominerend team
 *   2. Hoge xG, weinig goals in 1e helft → Over 2.5
 *   3. Lage xG, 0-0 voor rust → Under 2.5
 *   4. Extreme druk zonder goals → ML dominant team
 *
 * @param {object} deps
 *   - afGet                — async (host, path, params) → any
 *   - loadCalib            — fn () → calib
 *   - sleep                — fn (ms) → Promise
 *   - notify               — async (text, type?, userId?) → void
 *   - buildPickFactory     — fn (minOdds, calibEpBuckets, sport) → { picks, combiPool, mkP }
 *   - setLastLivePicks     — fn (picks[]) → void (atomic writer voor lastLivePicks)
 *   - leagues              — { football: [{id,name}] } — top-league whitelist
 * @returns {{ runLive: (emit) => Promise<picks[]>, getLivePicks: (emit, calibEpBuckets) => Promise<picks[]> }}
 */
module.exports = function createLiveScan(deps) {
  const { afGet, loadCalib, sleep, notify, buildPickFactory, setLastLivePicks, leagues } = deps;

  const required = { afGet, loadCalib, sleep, notify, buildPickFactory, setLastLivePicks, leagues };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createLiveScan: missing required dep '${key}'`);
    }
  }

  const AF_FOOTBALL_LEAGUES = leagues.football || [];

  async function getLivePicks(emit, calibEpBuckets = {}) {
    const topLeagueIds = new Set(AF_FOOTBALL_LEAGUES.map(l => l.id));
    const { picks, mkP } = buildPickFactory(1.50, calibEpBuckets);

    const liveFixtures = await afGet('v3.football.api-sports.io', '/fixtures', { live: 'all' });
    const candidates = liveFixtures
      .filter(f => topLeagueIds.has(f.league?.id))
      .slice(0, 12);

    emit({ log: `📡 Live: ${liveFixtures.length} wedstrijden | ${candidates.length} topcompetities` });
    if (!candidates.length) return [];

    const enriched = await Promise.all(candidates.map(async f => {
      const fid = f.fixture?.id;
      const [stats, liveOddsData] = await Promise.all([
        afGet('v3.football.api-sports.io', '/fixtures/statistics', { fixture: fid }),
        afGet('v3.football.api-sports.io', '/odds/live',           { fixture: fid }).catch(() => []),
      ]);
      await sleep(150);

      const getStat = (team, name) => {
        const ts = stats.find(s => s.team?.id === team?.id);
        return parseInt(ts?.statistics?.find(s => s.type === name)?.value || '0') || 0;
      };

      const hTeam = f.teams?.home, aTeam = f.teams?.away;
      const hG = f.goals?.home ?? 0, aG = f.goals?.away ?? 0;
      const min = f.fixture?.status?.elapsed || 0;

      const sotH  = getStat(hTeam, 'Shots on Goal');
      const sotA  = getStat(aTeam, 'Shots on Goal');
      const posH  = getStat(hTeam, 'Ball Possession');
      const cornH = getStat(hTeam, 'Corner Kicks');
      const cornA = getStat(aTeam, 'Corner Kicks');
      const dangH = getStat(hTeam, 'Blocked Shots') + sotH;
      const dangA = getStat(aTeam, 'Blocked Shots') + sotA;

      const xgH     = +(sotH * 0.33 + cornH * 0.05).toFixed(2);
      const xgA     = +(sotA * 0.33 + cornA * 0.05).toFixed(2);
      const xgTotal = xgH + xgA;

      const rawBks  = liveOddsData?.[0]?.bookmakers || [];
      const bet365  = rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
      const liveOdds = bet365 ? convertAfOdds([bet365], hTeam?.name || 'Home', aTeam?.name || 'Away') : [];

      return { f, fid, hTeam, aTeam, hG, aG, min,
               sotH, sotA, posH, cornH, cornA, xgH, xgA, xgTotal, dangH, dangA, liveOdds };
    }));

    for (const d of enriched) {
      const { f, hTeam, aTeam, hG, aG, min,
              sotH, sotA, posH, xgH, xgA, xgTotal, dangH, dangA, liveOdds } = d;

      if (min < 15 || min > 82) continue;

      const hm    = hTeam?.name || 'Thuis';
      const aw    = aTeam?.name || 'Uit';
      const lg    = f.league?.name || 'Football';
      const score = `${hG}-${aG}`;

      const h2h    = liveOdds.find(bk => bk.markets?.find(m => m.key === 'h2h'))?.markets?.find(m => m.key === 'h2h');
      const ouMkt  = liveOdds.find(bk => bk.markets?.find(m => m.key === 'totals'))?.markets?.find(m => m.key === 'totals');

      const liveH  = h2h?.outcomes?.find(o => o.name === hm)?.price;
      const liveA  = h2h?.outcomes?.find(o => o.name === aw)?.price;
      const liveOv = ouMkt?.outcomes?.find(o => o.name === 'Over' && Math.abs((o.point||2.5)-2.5)<0.01)?.price;
      const liveUn = ouMkt?.outcomes?.find(o => o.name === 'Under' && Math.abs((o.point||2.5)-2.5)<0.01)?.price;

      const xgEdge  = xgH - xgA;
      const reason  = (xg, sot, dom) =>
        `xG: ${xg.toFixed(1)} | SoT: ${sot} | Bezit: ${dom}% | ${score} in ${min}' · ${lg}`;

      if (hG <= aG && xgEdge > 0.8 && min < 70 && liveH) {
        const boost = clamp(xgEdge * 0.10, 0, 0.18);
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔄 ${hm} keert terug`, liveH,
          reason(xgH, sotH, posH), clamp(40+xgEdge*10,38,68), boost);
      }
      if (aG <= hG && -xgEdge > 0.8 && min < 70 && liveA) {
        const boost = clamp((-xgEdge) * 0.10, 0, 0.18);
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔄 ${aw} keert terug`, liveA,
          reason(xgA, sotA, 100-posH), clamp(40+(-xgEdge)*10,38,68), boost);
      }

      if (xgTotal > 2.4 && (hG+aG) < 2 && min < 65 && liveOv) {
        const boost = clamp((xgTotal-2.4)*0.07, 0, 0.15);
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `📈 Over 2.5 (xG ${xgTotal.toFixed(1)})`, liveOv,
          `xG total: ${xgTotal.toFixed(1)} | ${score} in ${min}' | SoT: ${sotH}+${sotA}`,
          clamp(45+(xgTotal-2.4)*12,42,72), boost);
      }

      if (xgTotal < 0.8 && (hG+aG) === 0 && min > 35 && min < 45 && liveUn) {
        const boost = clamp((0.8-xgTotal)*0.10, 0, 0.15);
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔒 Under 2.5 (lage xG)`, liveUn,
          `xG: ${xgTotal.toFixed(1)} | ${score} in ${min}' | SoT: ${sotH}+${sotA}`,
          clamp(55+(0.8-xgTotal)*20,48,70), boost);
      }

      if (dangH > dangA*2.5 && (hG+aG) === 0 && min > 20 && min < 70 && liveH) {
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `⚡ ${hm} scoort (druk ${(dangH/Math.max(1,dangA)).toFixed(1)}:1)`, liveH,
          `Gevaarlijk: ${dangH}vs${dangA} | xG ${xgH.toFixed(1)}-${xgA.toFixed(1)} | ${score} in ${min}'`,
          clamp(50+dangH*2.5,45,72), dangH*0.01);
      }
      if (dangA > dangH*2.5 && (hG+aG) === 0 && min > 20 && min < 70 && liveA) {
        mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `⚡ ${aw} scoort (druk ${(dangA/Math.max(1,dangH)).toFixed(1)}:1)`, liveA,
          `Gevaarlijk: ${dangA}vs${dangH} | xG ${xgA.toFixed(1)}-${xgH.toFixed(1)} | ${score} in ${min}'`,
          clamp(50+dangA*2.5,45,72), dangA*0.01);
      }
    }

    return picks.map(p => ({ ...p, scanType: 'live', sport: 'football', fixtureId: undefined }));
  }

  async function runLive(emit) {
    emit({ log: '🔴 Live scan · xG + live odds + balbezit' });
    const calib = loadCalib();
    const livePicks = await getLivePicks(emit, calib.epBuckets || {});

    if (!livePicks.length) {
      emit({ log: '📭 Geen picks.', picks: [] });
      return [];
    }

    const time = new Date().toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
    let msgs = [`🔴 LIVE · ${time}\n${livePicks.length} pick(s)\n\n`], cur = 0;
    for (const [i, p] of livePicks.entries()) {
      const star = i === 0 ? '⭐' : '🔵';
      const line = `${star} ${p.match}\n${p.league}\n📌 ${p.label}\n💰 ${p.odd} | ${p.units} | ${p.prob}% kans\n📊 ${p.reason}\n\n`;
      if ((msgs[cur]||'').length + line.length > 3900) { cur++; msgs.push(''); }
      msgs[cur] = (msgs[cur]||'') + line;
    }
    for (const msg of msgs) if (msg.trim()) await notify(msg).catch(()=>{});

    setLastLivePicks(livePicks);
    emit({ log: `✅ ${livePicks.length} live pick(s) gestuurd.`, picks: livePicks });
    return livePicks;
  }

  return { runLive, getLivePicks };
};
