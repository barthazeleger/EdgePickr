'use strict';

let preferredBookiesLower = null;

function setPreferredBookies(list) {
  if (Array.isArray(list) && list.length) {
    preferredBookiesLower = list.map(x => (x || '').toString().toLowerCase()).filter(Boolean);
  } else {
    preferredBookiesLower = null;
  }
}

function getPreferredBookies() {
  return preferredBookiesLower ? [...preferredBookiesLower] : null;
}

function fairProbs2Way(oddsArr) {
  if (!oddsArr || oddsArr.length < 2) return null;
  const home = oddsArr.find(o => o.side === 'home');
  const away = oddsArr.find(o => o.side === 'away');
  if (!home || !away || home.price < 1.01 || away.price < 1.01) return null;
  const totalIP = 1 / home.price + 1 / away.price;
  return { home: (1 / home.price) / totalIP, away: (1 / away.price) / totalIP };
}

function parseGameOdds(oddsResp, homeTeam, awayTeam) {
  const bookmakers = oddsResp?.[0]?.bookmakers || oddsResp?.bookmakers || [];
  if (!bookmakers.length) {
    return {
      moneyline: [],
      totals: [],
      spreads: [],
      halfML: [],
      halfTotals: [],
      halfSpreads: [],
      nrfi: [],
      oddEven: [],
      threeWay: [],
      teamTotals: [],
      doubleChance: [],
      dnb: [],
    };
  }

  const ml = [];
  const tots = [];
  const spr = [];
  const halfML = [];
  const halfTotals = [];
  const halfSpreads = [];
  const nrfi = [];
  const oddEven = [];
  const threeWay = [];
  const teamTotals = [];
  const doubleChance = [];
  const dnb = [];

  for (const bk of bookmakers) {
    const bkName = bk.name || bk.bookmaker?.name || 'Unknown';
    for (const bet of (bk.bets || [])) {
      const betId = bet.id;
      const betName = (bet.name || '').toLowerCase();

      const mlNames = ['match winner', 'home/away', 'winner', 'match odds', '3way result', 'moneyline', 'money line'];
      const isMlByName = mlNames.includes(betName);
      if (betId === 1 || isMlByName) {
        const vals = bet.values || [];
        const names = vals.map(v => String(v.value || '').trim()).sort().join('|');
        if (vals.length === 2 && names === 'Away|Home') {
          for (const v of vals) {
            const side = v.value === 'Home' ? 'home' : 'away';
            ml.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }

      const vals3 = (bet.values || []).filter(v => ['Home', 'Draw', 'Away', '1', 'X', '2'].includes(String(v.value ?? '').trim()));
      if (vals3.length === 3 && betId !== 1) {
        for (const v of vals3) {
          const s = String(v.value ?? '').trim();
          const side = (s === 'Home' || s === '1') ? 'home'
            : (s === 'Draw' || s === 'X') ? 'draw'
              : (s === 'Away' || s === '2') ? 'away' : null;
          if (side) threeWay.push({ side, price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }

      if (betId === 2 || betId === 3) {
        for (const v of (bet.values || [])) {
          const totalMatch = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            tots.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
          }
          const spreadMatch = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            spr.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price: parseFloat(v.odd) || 0,
              bookie: bkName,
            });
          }
        }
      }

      const is1H = betName.includes('1st half') || betName.includes('first half') || betName.includes('1st period') || betName.includes('first period') || betName.includes('1st inning');
      if (is1H) {
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          for (const v of (bet.values || [])) {
            const side = v.value === 'Home' ? 'home' : v.value === 'Away' ? 'away' : null;
            if (side) halfML.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
        for (const v of (bet.values || [])) {
          const totalMatch = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            halfTotals.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
          }
          const spreadMatch = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            halfSpreads.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price: parseFloat(v.odd) || 0,
              bookie: bkName,
            });
          }
        }
      }

      const isF5 = betName.includes('1st 5 inning') || betName.includes('first 5 inning') ||
        betName.includes('1st 5 innings') || betName.includes('f5 ');
      if (isF5) {
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          const vals = bet.values || [];
          const hasDraw = vals.some(v => String(v.value || '').trim() === 'Draw');
          for (const v of vals) {
            const val = String(v.value || '').trim();
            const price = parseFloat(v.odd) || 0;
            if (price <= 1.0) continue;
            if (val === 'Home') halfML.push({ side: 'home', name: homeTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Away') halfML.push({ side: 'away', name: awayTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Draw' && hasDraw) halfML.push({ side: 'draw', price, bookie: bkName, market: 'f5', hasDraw });
          }
        }
        for (const v of (bet.values || [])) {
          const totalMatch = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            halfTotals.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price: parseFloat(v.odd) || 0, bookie: bkName, market: 'f5' });
          }
          const spreadMatch = String(v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            halfSpreads.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price: parseFloat(v.odd) || 0,
              bookie: bkName,
              market: 'f5',
            });
          }
        }
      }

      if (betName.includes('1st inning') || betName.includes('nrfi') || betName.includes('first inning')) {
        for (const v of (bet.values || [])) {
          const val = (v.value || '').toLowerCase();
          if (val === 'yes' || val === 'no' || val === 'over' || val === 'under') {
            const isNRFI = val === 'no' || val === 'under';
            nrfi.push({ side: isNRFI ? 'nrfi' : 'yrfi', price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }

      const isTeamTotalBet = (betName.includes('home team total') || betName.includes('away team total')) &&
        !betName.includes('1st') && !betName.includes('2nd') && !betName.includes('3rd') &&
        !betName.includes('period') && !betName.includes('half') && !betName.includes('quarter');
      if (isTeamTotalBet) {
        const team = betName.includes('home') ? 'home' : 'away';
        for (const v of (bet.values || [])) {
          const totalMatch = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            const point = parseFloat(totalMatch[2]);
            const price = parseFloat(v.odd) || 0;
            if (price > 1.0 && isFinite(point)) {
              teamTotals.push({ team, side: totalMatch[1].toLowerCase(), point, price, bookie: bkName });
            }
          }
        }
      }

      if (betName.includes('double chance') && !betName.includes('half') && !betName.includes('period') && !betName.includes('quarter')) {
        for (const v of (bet.values || [])) {
          const val = String(v.value || '').trim();
          const price = parseFloat(v.odd) || 0;
          if (price <= 1.0) continue;
          let side = null;
          if (val === 'Home/Draw' || val === '1X') side = 'HX';
          else if (val === 'Home/Away' || val === '12') side = '12';
          else if (val === 'Draw/Away' || val === 'X2') side = 'X2';
          if (side) doubleChance.push({ side, price, bookie: bkName });
        }
      }

      if ((betName.includes('draw no bet') || betName === 'dnb') && !betName.includes('half') && !betName.includes('period')) {
        for (const v of (bet.values || [])) {
          const val = String(v.value || '').trim();
          const price = parseFloat(v.odd) || 0;
          if (price <= 1.0) continue;
          const side = val === 'Home' ? 'home' : val === 'Away' ? 'away' : null;
          if (side) dnb.push({ side, price, bookie: bkName });
        }
      }

      if (betName.includes('odd/even') || betName.includes('odd or even') || betName.includes('total odd') || betName.includes('total even')) {
        for (const v of (bet.values || [])) {
          const val = (v.value || '').toLowerCase();
          if (val === 'odd' || val === 'even') {
            oddEven.push({ side: val, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }
    }
  }

  const dedupeMainLine = (arr, keyFn) => {
    if (!arr.length) return arr;
    const seen = new Map();
    for (const o of arr) {
      const key = keyFn(o);
      const prev = seen.get(key);
      if (!prev || o.price < prev.price) seen.set(key, o);
    }
    return [...seen.values()];
  };
  const dedupeBestPrice = (arr, keyFn) => {
    if (!arr.length) return arr;
    const seen = new Map();
    for (const o of arr) {
      const key = keyFn(o);
      const prev = seen.get(key);
      if (!prev || o.price > prev.price) seen.set(key, o);
    }
    return [...seen.values()];
  };
  const kSide = o => `${(o.bookie || '').toLowerCase()}|${o.side}`;
  const kPoint = o => `${(o.bookie || '').toLowerCase()}|${o.side}|${o.point}`;
  const kTeam = o => `${(o.bookie || '').toLowerCase()}|${o.team}|${o.side}|${o.point}`;

  return {
    moneyline: dedupeBestPrice(ml, kSide),
    halfML: dedupeBestPrice(halfML, kSide),
    threeWay: dedupeBestPrice(threeWay, kSide),
    doubleChance: dedupeBestPrice(doubleChance, kSide),
    dnb: dedupeBestPrice(dnb, kSide),
    nrfi: dedupeBestPrice(nrfi, kSide),
    oddEven: dedupeBestPrice(oddEven, kSide),
    totals: dedupeMainLine(tots, kPoint),
    spreads: dedupeMainLine(spr, kPoint),
    halfTotals: dedupeMainLine(halfTotals, kPoint),
    halfSpreads: dedupeMainLine(halfSpreads, kPoint),
    teamTotals: dedupeMainLine(teamTotals, kTeam),
  };
}

function bestFromArr(arr) {
  let pool = arr || [];
  if (preferredBookiesLower && pool.length) {
    pool = pool.filter(o => preferredBookiesLower.some(p => (o.bookie || '').toLowerCase().includes(p)));
  }
  if (!pool.length) return { price: 0, bookie: '' };
  return pool.reduce((best, o) => (o.price > best.price ? { price: +o.price.toFixed(3), bookie: o.bookie } : best), { price: 0, bookie: '' });
}

function bestSpreadPick(spreads, fairProb, minEdge, minOdds = 1.60, maxOdds = 3.8) {
  if (!spreads || !spreads.length) return null;
  const byPoint = {};
  for (const s of spreads) {
    if (!s || typeof s.price !== 'number') continue;
    if (s.price < minOdds || s.price > maxOdds) continue;
    const key = String(s.point);
    (byPoint[key] = byPoint[key] || []).push(s);
  }
  for (const pt of Object.keys(byPoint)) {
    const bookieMap = {};
    for (const s of byPoint[pt]) {
      const bk = (s.bookie || '').toLowerCase();
      if (!bookieMap[bk] || s.price < bookieMap[bk].price) bookieMap[bk] = s;
    }
    byPoint[pt] = Object.values(bookieMap);
  }
  let best = null;
  for (const [pt, pool] of Object.entries(byPoint)) {
    const top = bestFromArr(pool);
    if (top.price <= 0) continue;
    const fp = typeof fairProb === 'function' ? fairProb(parseFloat(pt)) : fairProb;
    if (!fp || fp <= 0) continue;
    const edge = fp * top.price - 1;
    if (edge < minEdge) continue;
    if (!best || edge > best.edge) best = { ...top, point: parseFloat(pt), edge };
  }
  return best;
}

function buildSpreadFairProbFns(homeSpr, awaySpr, fallbackHome, fallbackAway) {
  const groupBy = (arr, fn) => {
    const out = {};
    for (const s of arr || []) {
      const key = fn(s);
      (out[key] = out[key] || []).push(s);
    }
    return out;
  };
  const homeByPt = groupBy(homeSpr, s => s.point);
  const awayByPt = groupBy(awaySpr, s => s.point);
  const avgIP = arr => arr.reduce((sum, o) => sum + 1 / o.price, 0) / arr.length;

  const tryDevig = (hArr, aArr) => {
    if (!hArr?.length || !aArr?.length) return null;
    const avgH = avgIP(hArr);
    const avgA = avgIP(aArr);
    const tot = avgH + avgA;
    if (tot > 1.00 && tot < 1.15) return { home: avgH / tot, away: avgA / tot, vig: tot - 1 };
    return null;
  };

  const probMap = {};
  for (const ptStr of Object.keys(homeByPt)) {
    const pt = parseFloat(ptStr);
    const samePoint = tryDevig(homeByPt[pt], awayByPt[pt]);
    const oppPoint = tryDevig(homeByPt[pt], awayByPt[-pt]);
    let chosen;
    if (samePoint && oppPoint) chosen = samePoint.vig <= oppPoint.vig ? samePoint : oppPoint;
    else chosen = samePoint || oppPoint;
    if (chosen) probMap[pt] = chosen;
  }

  return {
    homeFn: pt => probMap[pt]?.home ?? fallbackHome,
    awayFn: pt => probMap[pt]?.away ?? probMap[-pt]?.away ?? fallbackAway,
  };
}

module.exports = {
  fairProbs2Way,
  parseGameOdds,
  setPreferredBookies,
  getPreferredBookies,
  bestFromArr,
  bestSpreadPick,
  buildSpreadFairProbFns,
};
