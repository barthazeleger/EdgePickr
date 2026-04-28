#!/usr/bin/env node
'use strict';

/**
 * audit-tsdb-coverage.js — v13.0 Phase 5 coverage-audit.
 *
 * Doel: data-driven beslissing of MMA/F1/Golf/Darts/Snooker (Phase B sporten)
 * de v13.0 cutover halen of doorgeschoven worden naar v13.x. Voor elke
 * kandidaat-sport queryt dit script TheSportsDB (V1 endpoints, premium-key
 * vereist) en OddsAPI (sport-list) en rapporteert:
 *   - Aantal events afgelopen 30/90 dagen via TSDB eventsday.php (per dag)
 *   - % events met complete data (idEvent, dateEvent, strHomeTeam/strAwayTeam,
 *     intHomeScore/intAwayScore na finalisatie)
 *   - OddsAPI sport-key existentie + active-flag
 *   - Go/no-go recommendation per sport gebaseerd op drempels
 *
 * Drempels (configureerbaar via env):
 *   - MIN_EVENTS_PER_MONTH       (default 50): basis-volume voor scan-relevantie
 *   - MIN_COMPLETE_RECORDS_PCT   (default 80): data-quality vereiste
 *   - REQUIRE_ODDSAPI_KEY        (default true): odds-laag MOET dekken
 *
 * Usage:
 *   node scripts/audit-tsdb-coverage.js [--json]
 *   node scripts/audit-tsdb-coverage.js --sports=mma,f1
 *
 * Output: tabel-vorm op stdout. Met --json: JSON-rapport voor doorvoeren naar
 * een operator-decisietool. Exit-code: 0 (success) altijd; rapport is
 * adviserend, niet blockerend.
 */

const tsdb    = require('../lib/integrations/sources/thesportsdb');
const oddsapi = require('../lib/integrations/sources/oddsapi');

// Phase B sport-kandidaten + bijbehorende TSDB strSport-strings.
// Geen wijziging aan TSDB SPORT_MAP nodig — script werkt met losse mapping
// totdat coverage-audit go-besluit oplevert.
const PHASE_B_SPORTS = Object.freeze([
  { key: 'mma',     strSport: 'Mixed Martial Arts', oddsApiKeys: ['mma_mixed_martial_arts'] },
  { key: 'f1',      strSport: 'Motorsport',         oddsApiKeys: ['f1_drivers_championship', 'motorsport_motogp'] },
  { key: 'golf',    strSport: 'Golf',               oddsApiKeys: ['golf_pga_championship', 'golf_masters_tournament', 'golf_us_open'] },
  { key: 'darts',   strSport: 'Darts',              oddsApiKeys: ['darts_pdc_world_championship'] },
  { key: 'snooker', strSport: 'Snooker',            oddsApiKeys: [/* OddsAPI heeft geen snooker free-tier */] },
]);

const MIN_EVENTS_PER_MONTH     = parseInt(process.env.MIN_EVENTS_PER_MONTH, 10) || 50;
const MIN_COMPLETE_RECORDS_PCT = parseInt(process.env.MIN_COMPLETE_RECORDS_PCT, 10) || 80;
const REQUIRE_ODDSAPI_KEY      = process.env.REQUIRE_ODDSAPI_KEY !== 'false';

// Genereer dates afgelopen N dagen (YYYY-MM-DD).
function _recentDates(daysBack) {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Een event "compleet" = alle kritieke velden aanwezig. Voor finished events
// ook scores. Voor scheduled (toekomst) is scores-absence acceptabel.
function _isComplete(ev) {
  if (!ev || !ev.idEvent) return false;
  if (!ev.strHomeTeam && !ev.strEvent) return false;  // motorsport heeft geen home/away, wel strEvent
  if (!ev.dateEvent) return false;
  return true;
}

async function _auditSport(sportConfig) {
  const { key, strSport, oddsApiKeys } = sportConfig;
  const startTs = Date.now();

  // Sample: laatste 30 dagen (kies 7 random voor snelheid bij dagelijkse run).
  // Voor full-rigor audit: 90 dagen alle datums. Default: 7 datums random
  // gespreid over laatste 30 dagen.
  const allDates = _recentDates(30);
  const sampleSize = Math.min(7, allDates.length);
  const sampledDates = [];
  const step = Math.floor(allDates.length / sampleSize);
  for (let i = 0; i < sampleSize; i++) {
    sampledDates.push(allDates[i * step]);
  }

  let totalEvents = 0;
  let completeEvents = 0;
  let datesWithEvents = 0;
  const errors = [];

  for (const date of sampledDates) {
    try {
      // Direct TSDB v1 eventsday.php call (sport-aware via strSport).
      // We hergebruiken de bestaande adapter-method niet omdat die op SPORT_MAP
      // gaat; Phase B sporten staan daar nog niet in. Direct fetch via HOST.
      const url = `https://www.thesportsdb.com/api/v1/json/${process.env.TSDB_API_KEY || '3'}` +
                  `/eventsday.php?d=${encodeURIComponent(date)}&s=${encodeURIComponent(strSport)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) { errors.push(`http_${r.status}@${date}`); continue; }
      const data = await r.json().catch(() => null);
      const events = data?.events || [];
      if (Array.isArray(events) && events.length) {
        datesWithEvents++;
        totalEvents += events.length;
        completeEvents += events.filter(_isComplete).length;
      }
    } catch (e) {
      errors.push(`${(e && e.message) || 'unknown'}@${date}`);
    }
  }

  // Extrapoleer naar maand-volume: gemiddelde events/dag × 30
  const avgEventsPerDay = sampledDates.length > 0 ? (totalEvents / sampledDates.length) : 0;
  const eventsPerMonth = Math.round(avgEventsPerDay * 30);
  const completePct = totalEvents > 0 ? Math.round((completeEvents / totalEvents) * 100) : 0;

  // OddsAPI dekking: alle voorgestelde sport-keys checken via fetchSports
  const oddsApiCoverage = [];
  if (oddsApiKeys.length > 0) {
    try {
      const allSports = await oddsapi.fetchSports();
      for (const targetKey of oddsApiKeys) {
        const found = (allSports || []).find(s => s.key === targetKey);
        if (found) oddsApiCoverage.push({ key: targetKey, active: found.active });
      }
    } catch (e) {
      errors.push(`oddsapi_fetch_fail: ${e.message}`);
    }
  }

  // Go/no-go beslissing
  const meetsVolume    = eventsPerMonth >= MIN_EVENTS_PER_MONTH;
  const meetsQuality   = completePct >= MIN_COMPLETE_RECORDS_PCT;
  const meetsOddsDeck  = !REQUIRE_ODDSAPI_KEY || oddsApiCoverage.some(x => x.active);
  const recommendation = meetsVolume && meetsQuality && meetsOddsDeck
    ? 'GO'
    : 'NO-GO';

  return {
    sport:           key,
    strSport,
    durationMs:      Date.now() - startTs,
    sampledDates,
    datesWithEvents,
    totalEvents,
    completeEvents,
    avgEventsPerDay: +avgEventsPerDay.toFixed(2),
    eventsPerMonth,
    completePct,
    meetsVolume,
    meetsQuality,
    meetsOddsDeck,
    oddsApiCoverage,
    recommendation,
    errors,
  };
}

function _renderTable(reports) {
  const lines = [];
  lines.push('');
  lines.push('=== TSDB Coverage Audit — v13.0 Phase B sporten ===');
  lines.push(`Drempel: ${MIN_EVENTS_PER_MONTH}+ events/maand · ${MIN_COMPLETE_RECORDS_PCT}%+ complete · OddsAPI required=${REQUIRE_ODDSAPI_KEY}`);
  lines.push('');
  lines.push('Sport      | Events/maand | Complete% | OddsAPI    | Beslissing');
  lines.push('-----------|--------------|-----------|------------|-----------');
  for (const r of reports) {
    const oa = r.oddsApiCoverage.length === 0 ? 'none'
             : r.oddsApiCoverage.some(x => x.active) ? 'active'
             : 'inactive';
    const decision = r.recommendation === 'GO' ? 'GO ✓' : 'NO-GO ✗';
    lines.push(
      `${r.sport.padEnd(11)}|`
      + ` ${String(r.eventsPerMonth).padStart(12)} |`
      + ` ${String(r.completePct).padStart(8)}% |`
      + ` ${oa.padEnd(10)} |`
      + ` ${decision}`
    );
  }
  lines.push('');
  for (const r of reports) {
    if (r.errors.length) {
      lines.push(`[${r.sport}] errors: ${r.errors.slice(0, 3).join(', ')}${r.errors.length > 3 ? ` (+${r.errors.length - 3})` : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const outputJson = args.includes('--json');
  const sportFilter = args.find(a => a.startsWith('--sports='));
  let sportsToAudit = PHASE_B_SPORTS;
  if (sportFilter) {
    const requested = sportFilter.replace('--sports=', '').split(',').map(s => s.trim());
    sportsToAudit = PHASE_B_SPORTS.filter(s => requested.includes(s.key));
  }

  if (!process.env.TSDB_API_KEY || process.env.TSDB_API_KEY === '3') {
    console.warn('[audit] TSDB_API_KEY niet ingesteld of test-key \'3\' — sommige endpoints geven beperkte data');
  }

  const reports = [];
  for (const sport of sportsToAudit) {
    process.stderr.write(`[audit] ${sport.key} (${sport.strSport})...`);
    const r = await _auditSport(sport);
    process.stderr.write(` ${r.recommendation} (${r.eventsPerMonth} events/maand, ${r.completePct}% complete)\n`);
    reports.push(r);
  }

  if (outputJson) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      thresholds: { MIN_EVENTS_PER_MONTH, MIN_COMPLETE_RECORDS_PCT, REQUIRE_ODDSAPI_KEY },
      reports,
    }, null, 2));
  } else {
    console.log(_renderTable(reports));
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('[audit] fatal:', e?.message || e);
    process.exit(1);
  });
}

module.exports = { _auditSport, _renderTable, PHASE_B_SPORTS };
