'use strict';

/**
 * v15.0.12 · Settlement event-stats enrichment worker.
 *
 * Loopt 1× per dag (nachts, buiten scan-windows). Pakt settled bets
 * (uitkomst W/L) zonder tsdb_event_stats payload, fetched per fixture de TSDB
 * event-stats (shots/possession/corners/cards), en schrijft het JSONB-blob
 * naar de bets-row.
 *
 * Doel: voeden van v15.0.13+ calibratie-modellen met dominance-data zonder
 * de pre-match scan te raken. Pure post-settlement enrichment.
 *
 * Eisen:
 *   - Bet moet `fixture_id` hebben (kan ontbreken voor pre-resolveFixtureIdForBet bets).
 *   - TSDB event-id niet bekend → skip (helper kan in toekomst event-id resolven via fixture).
 *   - Limit per run: 30 (rate-limit-friendly, 30×600ms = 18s totale TSDB-tijd).
 */

const DEFAULT_BATCH_LIMIT = 30;

async function runSettlementStatsEnrichment(deps) {
  const { supabase, tsdb, logger } = deps;
  if (!supabase || !tsdb) {
    return { ok: false, reason: 'missing_deps', enriched: 0, skipped: 0 };
  }
  const log = logger || console.log;

  const limit = deps.limit || DEFAULT_BATCH_LIMIT;
  const startedAt = Date.now();

  // Pak settled bets zonder enrichment. fixture_id is essentieel — zonder
  // hebben we geen route naar TSDB event_stats. tsdb_event_id (toekomstige
  // kolom) zou directer zijn maar bestaat nog niet.
  let bets;
  try {
    const { data, error } = await supabase.from('bets')
      .select('bet_id, sport, wedstrijd, datum, fixture_id, tsdb_event_id')
      .in('uitkomst', ['W', 'L'])
      .is('tsdb_event_stats', null)
      .not('fixture_id', 'is', null)
      .limit(limit);
    if (error) {
      log('[settlement-enrichment] select failed:', error.message);
      return { ok: false, reason: 'select_failed', enriched: 0, skipped: 0, error: error.message };
    }
    bets = data || [];
  } catch (e) {
    log('[settlement-enrichment] crash:', e?.message || e);
    return { ok: false, reason: 'crash', enriched: 0, skipped: 0, error: String(e?.message || e) };
  }

  if (bets.length === 0) {
    log('[settlement-enrichment] geen openstaande enrichment-rows');
    return { ok: true, enriched: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }

  let enriched = 0;
  let skipped = 0;
  for (const bet of bets) {
    const eventId = bet.tsdb_event_id || null;
    if (!eventId) { skipped++; continue; }
    try {
      const stats = await tsdb.fetchEventStats(eventId);
      if (!Array.isArray(stats) || stats.length === 0) {
        skipped++;
        continue;
      }
      const payload = {
        fetched_at: new Date().toISOString(),
        eventId: String(eventId),
        stats: stats.slice(0, 50),
      };
      const { error } = await supabase.from('bets')
        .update({ tsdb_event_stats: payload })
        .eq('bet_id', bet.bet_id);
      if (error) {
        log('[settlement-enrichment] update failed bet_id=', bet.bet_id, error.message);
        skipped++;
        continue;
      }
      enriched++;
    } catch (e) {
      log('[settlement-enrichment] fetch crash bet_id=', bet.bet_id, e?.message || e);
      skipped++;
    }
  }

  log(`[settlement-enrichment] ${enriched} enriched / ${skipped} skipped / ${bets.length} probed`);
  return {
    ok: true,
    enriched,
    skipped,
    probed: bets.length,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  runSettlementStatsEnrichment,
  DEFAULT_BATCH_LIMIT,
};
