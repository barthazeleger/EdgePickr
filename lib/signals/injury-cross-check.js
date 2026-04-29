'use strict';

/**
 * v15.0.12 · Injury cross-check (TSDB lookup_all_players.php).
 *
 * Pure helper. Vergelijkt api-sports geblesseerde-spelerslijst met TSDB roster.
 * Gebruik: data-quality monitoring — als api-sports zegt "X is out" maar TSDB
 * roster bevat X niet, is een van twee dingen waar:
 *   1. api-sports rapporteert een fictieve/stale-injury (false positive)
 *   2. TSDB roster is verouderd (missing player), dataquality issue
 *
 * Signal werkt alleen als telemetrie — geen pick-impact, geen drop. Operator
 * kan via /api/admin/v2/injury-cross-check zien hoe vaak mismatches voorkomen
 * en bij welke teams. Daarna kan beslist worden of een tweede injury-bron
 * nodig is.
 */

function _normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array} apiSportsInjuries - [{player: 'X', team: 'Y', ...}, ...]
 * @param {Array} tsdbRoster - TSDB roster: [{playerId, name, position, ...}, ...]
 * @returns {{matched, unmatched, mismatchPct, total}} — totals voor één team
 */
function crossCheckInjuries(apiSportsInjuries, tsdbRoster) {
  const out = { matched: [], unmatched: [], total: 0, mismatchPct: 0 };
  if (!Array.isArray(apiSportsInjuries) || apiSportsInjuries.length === 0) return out;
  if (!Array.isArray(tsdbRoster) || tsdbRoster.length === 0) {
    // Geen roster → kan niet kruis-checken; markeer alle als unmatched.
    out.total = apiSportsInjuries.length;
    out.unmatched = apiSportsInjuries.map(i => ({
      player: String(i?.player || i?.name || ''),
      reason: 'no_roster',
    }));
    out.mismatchPct = 100;
    return out;
  }
  const rosterNames = new Set();
  for (const p of tsdbRoster) {
    const n = _normName(p?.name || p?.player || p?.strPlayer);
    if (n) rosterNames.add(n);
  }
  for (const inj of apiSportsInjuries) {
    out.total++;
    const candidate = _normName(inj?.player || inj?.name);
    if (!candidate) {
      out.unmatched.push({ player: String(inj?.player || ''), reason: 'malformed' });
      continue;
    }
    if (rosterNames.has(candidate)) {
      out.matched.push(candidate);
      continue;
    }
    // Substring/last-name fallback om naamvarianten op te vangen
    // (bv. "M. Salah" vs "Mohamed Salah"). Strikt: ALLE qualifying tokens
    // (≥3 chars) moeten matchen om false-positives op gemeenschappelijke
    // achternamen ("Smith", "Speler") te vermijden.
    let fuzzy = false;
    const candidateTokens = candidate.split(' ').filter(t => t.length >= 3);
    if (candidateTokens.length === 0) {
      // Te kort om fuzzy te matchen (bv. enkel initialen).
      // Skip — alleen exacte match is veilig.
    } else {
      for (const rn of rosterNames) {
        if (rn.includes(candidate) || candidate.includes(rn)) { fuzzy = true; break; }
        const allMatch = candidateTokens.every(tok => rn.includes(tok));
        if (allMatch) { fuzzy = true; break; }
      }
    }
    if (fuzzy) {
      out.matched.push(candidate);
    } else {
      out.unmatched.push({ player: String(inj?.player || ''), reason: 'not_in_roster' });
    }
  }
  out.mismatchPct = out.total > 0 ? +((out.unmatched.length / out.total) * 100).toFixed(1) : 0;
  return out;
}

module.exports = {
  crossCheckInjuries,
  _normName,
};
