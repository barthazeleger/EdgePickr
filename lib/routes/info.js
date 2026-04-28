'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * v11.2.7-9 · Phase 5.4e: Info/meta read-only routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createInfoRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/version   — APP_VERSION + last 10 model-log entries
 *   - GET /api/changelog — parse CHANGELOG.md → JSON entries (admin-only)
 *   - GET /api/status    — uptime + service status per subsystem + model + stake-regime
 *
 * Status-specifieke deps zijn optional (als niet geleverd, wordt /api/status
 * niet gemount). Info+changelog krijg je altijd.
 *
 * @param {object} deps
 *   - appVersion         — string (APP_VERSION constant)
 *   - loadCalib          — fn () → calibration object (voor modelLog)
 *   - requireAdmin       — Express middleware
 *   - changelogPath      — optional absolute path
 *   - afKey              — optional string (api-football key) voor status
 *   - afRateLimit        — optional object {remaining, limit, callsToday, updatedAt}
 *   - sportRateLimits    — optional object
 *   - tsdbAdapter        — optional TheSportsDB module (v12.6.3) — voor getUsage()
 *   - oddsApiAdapter     — optional OddsAPI module (v12.7.0-pre2) — voor getUsage()
 *   - getCurrentStakeRegime — optional () → regime|null
 *   - leagues            — optional { football, basketball, hockey, baseball, 'american-football', handball }
 * @returns {express.Router}
 */
module.exports = function createInfoRouter(deps) {
  const { appVersion, loadCalib, requireAdmin } = deps;
  const changelogPath = deps.changelogPath || path.join(__dirname, '..', '..', 'CHANGELOG.md');

  const required = { appVersion, loadCalib, requireAdmin };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createInfoRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // Optional /api/status mount — alleen als status-deps geleverd zijn.
  const { afKey, afRateLimit, sportRateLimits, tsdbAdapter, oddsApiAdapter, getCurrentStakeRegime, leagues } = deps;
  if (afRateLimit && sportRateLimits && getCurrentStakeRegime && leagues) {
    router.get('/status', (req, res) => {
      const uptime = process.uptime();
      const c = loadCalib();
      const _regime = getCurrentStakeRegime();
      const leagueMap = (arr) => (arr || []).map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha }));

      // v12.6.3: api-sports tier-shift 13-05-2026 — All Sports €85/mnd valt
      // weg, vervangen door Football Pro $19,99 (75k/dag football) + free
      // tier voor 5 andere sporten (100/dag/sport). Frontend kan met `tier`
      // het juiste limit-target tonen. Limit-defaults volgen de actuele
      // response-headers uit api-sports zelf — deze object-fields zijn
      // fallback bij ontbrekende headers.
      const today = new Date().toISOString().slice(0, 10);
      const tierShiftDate = '2026-05-13';
      const onNewTier = today >= tierShiftDate;
      const apiSportsTier = onNewTier ? 'football-pro+free' : 'all-sports';
      const footballLimit  = onNewTier ? 75000 : 7500;
      const otherSportLimit = onNewTier ? 100   : 7500;

      // v12.6.3: TSDB usage (no quota — pure observability via call-counter).
      const tsdbUsage = tsdbAdapter?.getUsage ? tsdbAdapter.getUsage() : null;

      res.json({
        version:    appVersion,
        uptime:     Math.round(uptime),
        uptimeStr:  uptime > 86400 ? `${Math.floor(uptime/86400)}d ${Math.floor((uptime%86400)/3600)}h`
                  : uptime > 3600 ? `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`
                  : `${Math.floor(uptime/60)}m`,
        services: {
          apiFootball: {
            status: !!afKey ? 'active' : 'no key',
            plan: onNewTier ? 'Football Pro + Free' : 'All Sports',
            tier: apiSportsTier,
            tierShiftDate,
            remaining: afRateLimit.remaining,
            limit: afRateLimit.limit || footballLimit,
            callsToday: afRateLimit.callsToday || 0,
            usedPct: Math.round((afRateLimit.callsToday || 0) / (afRateLimit.limit || footballLimit) * 100),
            updatedAt: afRateLimit.updatedAt,
            perSport: {
              football:            { calls: sportRateLimits.football?.callsToday            || 0, limit: footballLimit },
              basketball:          { calls: sportRateLimits.basketball?.callsToday          || 0, limit: otherSportLimit },
              hockey:              { calls: sportRateLimits.hockey?.callsToday              || 0, limit: otherSportLimit },
              baseball:            { calls: sportRateLimits.baseball?.callsToday            || 0, limit: otherSportLimit },
              'american-football': { calls: sportRateLimits['american-football']?.callsToday || 0, limit: otherSportLimit },
              handball:            { calls: sportRateLimits.handball?.callsToday            || 0, limit: otherSportLimit },
            },
          },
          tsdb: {
            status: tsdbUsage?.premium ? 'active' : 'free-key',
            plan: tsdbUsage?.premium ? 'Premium €9/mnd' : 'Free (test-key)',
            note: tsdbUsage?.premium
              ? 'TheSportsDB Premium · 100 req/min · v1+v2 endpoints · multi-sport h2h/lineups/livescores'
              : 'TheSportsDB free test-key · beperkt v1, geen v2',
            callsToday: tsdbUsage?.callsToday || 0,
            rateLimitMs: tsdbUsage?.rateLimitMs || null,
            premium: !!tsdbUsage?.premium,
          },
          oddsApi: (() => {
            // v12.7.0-pre2: gebruik adapter.getUsage() als beschikbaar voor
            // authoritative state (call-counts uit response-headers); fallback
            // op env-var check + 'planned' status pre-adapter.
            const u = oddsApiAdapter?.getUsage ? oddsApiAdapter.getUsage() : null;
            if (!u) {
              return {
                status: process.env.ODDSAPI_KEY || process.env.ODDSPAPI_KEY ? 'key-set' : 'planned',
                plan: 'Free 500/mo',
                note: 'The Odds API · v4 · Bet365/Pinnacle/Unibet odds · h2h/spreads/totals',
              };
            }
            return {
              status: u.hasKey ? (u.degraded ? 'degraded' : 'active') : 'planned',
              plan: 'Free 500/mo',
              note: 'The Odds API · v4 · Bet365/Pinnacle/Unibet odds · h2h/spreads/totals',
              callsThisMonth: u.callsThisMonth,
              remaining: u.remaining,
              monthlyQuota: u.monthlyQuota,
              softLimit: u.softLimit,
              degraded: u.degraded,
            };
          })(),
          espn: { status: 'active', plan: 'Free', unlimited: true, note: 'Live scores auto-refresh' },
          supabase: { status: 'active', plan: 'Free', unlimited: true, note: 'PostgreSQL · 500MB · bets/users/calibratie/snapshots' },
          webPush: { status: (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) ? 'active' : 'no key', plan: 'Free', unlimited: true, note: 'Operator alerts · picks · model updates (VAPID)' },
          render: { status: 'active', plan: 'Free', unlimited: true, note: 'Hosting + keep-alive elke 14 min' },
          mlbStats: { status: 'active', plan: 'Free', unlimited: true, note: 'MLB pitcher stats (api.mlb.com/api/v1)' },
          nhlPublic: { status: 'active', plan: 'Free', unlimited: true, note: 'NHL shots-differential + lineups' },
          openMeteo: { status: 'active', plan: 'Free', unlimited: true, note: 'Weer voor outdoor wedstrijden (open-meteo.com)' },
        },
        model: {
          totalSettled: c.totalSettled || 0,
          totalWins: c.totalWins || 0,
          lastCalibration: c.modelLastUpdated || null,
          marketsTracked: Object.keys(c.markets || {}).filter(k => (c.markets[k]?.n || 0) > 0).length,
        },
        stakeRegime: _regime ? {
          regime: _regime.regime,
          kellyFraction: _regime.kellyFraction,
          unitMultiplier: _regime.unitMultiplier,
          reasons: _regime.reasons || [],
        } : null,
        leagues: {
          football:            leagueMap(leagues.football),
          basketball:          leagueMap(leagues.basketball),
          hockey:              leagueMap(leagues.hockey),
          baseball:            leagueMap(leagues.baseball),
          'american-football': leagueMap(leagues['american-football']),
          handball:            leagueMap(leagues.handball),
        },
      });
    });
  }

  router.get('/version', (req, res) => {
    const c = loadCalib();
    res.json({
      version:          appVersion,
      modelLog:         (c.modelLog || []).slice(0, 10),
      modelLastUpdated: c.modelLastUpdated || null,
    });
  });

  router.get('/changelog', requireAdmin, (req, res) => {
    try {
      const raw = fs.readFileSync(changelogPath, 'utf8');
      const entries = [];
      // Split op "## [x.y.z] - date" secties
      const blocks = raw.split(/\n(?=## \[)/);
      for (const block of blocks) {
        const hdr = block.match(/^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (!hdr) continue;
        const version = hdr[1], date = hdr[2];
        // Binnen het block: ### Section headers
        const body = block.slice(hdr[0].length).trim();
        const sections = [];
        const parts = body.split(/\n(?=### )/);
        for (const p of parts) {
          const sh = p.match(/^### ([^\n]+)/);
          if (!sh) continue;
          const title = sh[1].trim();
          const text = p.slice(sh[0].length).trim();
          sections.push({ title, text });
        }
        entries.push({ version, date, sections });
      }
      res.json({ version: appVersion, entries });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Kan CHANGELOG niet lezen' });
    }
  });

  return router;
};
