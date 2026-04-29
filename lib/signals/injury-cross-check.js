'use strict';

/**
 * v15.0.12 · Injury cross-check (TSDB lookup_all_players.php).
 * v15.0.13 · Reason-bucketing + thin-roster guard.
 *
 * Pure helper. Vergelijkt api-sports geblesseerde-spelerslijst met TSDB roster.
 * Gebruik: data-quality monitoring — als api-sports zegt "X is out" maar TSDB
 * roster bevat X niet, is een van twee dingen waar:
 *   1. api-sports rapporteert een fictieve/stale-injury (false positive)
 *   2. TSDB roster is verouderd of incompleet (data-quality issue)
 *
 * v15.0.13 fix: eerste live scans toonden 90% mismatch-rate omdat TSDB rosters
 * voor exotische liga's (Saudi/Egypt/NB I) regelmatig <15 spelers terugkrijgen
 * of helemaal leeg zijn. Dat is een TSDB-coverage probleem, niet een
 * data-quality signaal — die buckets worden nu apart geteld zodat operator
 * direct ziet of de signal-ruis komt van naam-matching of van dunne rosters.
 *
 * Signal werkt alleen als telemetrie — geen pick-impact, geen drop. Operator
 * ziet de bucket-breakdown in de scan-log regel.
 */

// Een serieuze voetbal-squad heeft typisch 22-30 spelers. Onder de 15 is het
// rooster zo dun dat een "niet gevonden" geen data-quality signaal meer is —
// dan is het een TSDB-coverage gat.
const THIN_ROSTER_THRESHOLD = 15;

function _normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pak de "achternaam" uit een genormaliseerde string. Voor "m. salah" → "salah",
// voor "cristiano ronaldo" → "ronaldo", voor "van dijk" (compound) → "dijk".
// Heuristiek: laatste token >= 3 chars wint; anders laatste token überhaupt.
function _lastName(norm) {
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].length >= 3) return tokens[i];
  }
  return tokens[tokens.length - 1];
}

// Initial van first name (bv. "m" voor "Mohamed Salah").
function _firstInitial(norm) {
  const t = norm.split(' ').filter(Boolean);
  return t[0] ? t[0][0] : '';
}

/**
 * @param {Array} apiSportsInjuries - [{player: 'X', team: 'Y', ...}, ...]
 * @param {Array} tsdbRoster - TSDB roster: [{playerId, name, position, ...}, ...]
 * @returns {{matched, unmatched, total, mismatchPct, reasons}} per-team breakdown.
 *   - matched: array genormaliseerde namen die matchten
 *   - unmatched: array {player, reason} — reasons: 'malformed', 'name_unmatched'
 *   - reasons: {no_roster, thin_roster, malformed, name_unmatched, matched} counts
 *     reflecteert de bucket waarin elke injury terechtkwam (handig voor scan-log)
 *   - mismatchPct: alleen op signal-relevante mismatches (name_unmatched), niet
 *     op no_roster/thin_roster (die zijn TSDB-coverage gat, geen data-quality)
 */
function crossCheckInjuries(apiSportsInjuries, tsdbRoster) {
  const reasons = { no_roster: 0, thin_roster: 0, malformed: 0, name_unmatched: 0, matched: 0 };
  const out = { matched: [], unmatched: [], total: 0, mismatchPct: 0, reasons };
  if (!Array.isArray(apiSportsInjuries) || apiSportsInjuries.length === 0) return out;

  out.total = apiSportsInjuries.length;
  const rosterSize = Array.isArray(tsdbRoster) ? tsdbRoster.length : 0;

  if (rosterSize === 0) {
    // Geen roster → kan niet cross-checken; alle injuries krijgen no_roster bucket.
    for (const inj of apiSportsInjuries) {
      out.unmatched.push({ player: String(inj?.player || inj?.name || ''), reason: 'no_roster' });
      reasons.no_roster++;
    }
    out.mismatchPct = 0; // geen signal — TSDB-coverage probleem, niet data-quality
    return out;
  }

  if (rosterSize < THIN_ROSTER_THRESHOLD) {
    // Roster te dun (<15 spelers) om iets te besluiten over fictieve injuries.
    // Markeer alle als thin_roster en tel niet mee in mismatchPct.
    for (const inj of apiSportsInjuries) {
      out.unmatched.push({ player: String(inj?.player || inj?.name || ''), reason: 'thin_roster' });
      reasons.thin_roster++;
    }
    out.mismatchPct = 0;
    return out;
  }

  // Roster is bruikbaar — bouw lookup-structuren op.
  const rosterNorms = [];
  const rosterLastNames = new Map(); // lastName → set of {fullNorm, firstInitial}
  for (const p of tsdbRoster) {
    const fullNorm = _normName(p?.name || p?.player || p?.strPlayer);
    if (!fullNorm) continue;
    rosterNorms.push(fullNorm);
    const ln = _lastName(fullNorm);
    if (!ln) continue;
    if (!rosterLastNames.has(ln)) rosterLastNames.set(ln, []);
    rosterLastNames.get(ln).push({ fullNorm, fi: _firstInitial(fullNorm) });
  }

  for (const inj of apiSportsInjuries) {
    const candidate = _normName(inj?.player || inj?.name);
    if (!candidate) {
      out.unmatched.push({ player: String(inj?.player || ''), reason: 'malformed' });
      reasons.malformed++;
      continue;
    }
    // 1. Exact match op volledige genormaliseerde naam.
    if (rosterNorms.includes(candidate)) {
      out.matched.push(candidate);
      reasons.matched++;
      continue;
    }
    // 2. Substring-match: candidate zit in roster-name of vice versa
    //    (bv. "salah" ⊂ "mohamed salah", of "cristiano ronaldo dos santos" ⊃ "cristiano ronaldo").
    let matched = false;
    for (const rn of rosterNorms) {
      if (rn.includes(candidate) || candidate.includes(rn)) { matched = true; break; }
    }
    if (matched) { out.matched.push(candidate); reasons.matched++; continue; }
    // 3. Last-name + first-initial match. Vangt "M. Salah" ↔ "Mohamed Salah",
    //    "C. Ronaldo" ↔ "Cristiano Ronaldo", "L. Messi" ↔ "Lionel Messi".
    //    Strikt: de candidate-laatste-naam moet in roster's lastName-index staan
    //    EN de first-initial moet matchen — anders cross-team naam-collisions
    //    (bv. twee spelers genaamd "Smith" op rivaliserende teams).
    const candLast = _lastName(candidate);
    const candFi = _firstInitial(candidate);
    if (candLast && candLast.length >= 3 && rosterLastNames.has(candLast)) {
      const candidates = rosterLastNames.get(candLast);
      // Als candidate alleen een initial heeft of geen first name (just last):
      // accepteer eerste roster-match op last name.
      if (!candFi || candidate === candLast) {
        out.matched.push(candidate);
        reasons.matched++;
        continue;
      }
      // Anders moet first-initial matchen.
      if (candidates.some(c => c.fi === candFi)) {
        out.matched.push(candidate);
        reasons.matched++;
        continue;
      }
    }
    // Geen match gevonden → echte data-quality signaal.
    out.unmatched.push({ player: String(inj?.player || ''), reason: 'name_unmatched' });
    reasons.name_unmatched++;
  }

  // mismatchPct rekent ALLEEN name_unmatched (signaal-relevant), niet TSDB-gaten.
  const signalRelevant = reasons.matched + reasons.name_unmatched + reasons.malformed;
  out.mismatchPct = signalRelevant > 0
    ? +((reasons.name_unmatched / signalRelevant) * 100).toFixed(1)
    : 0;
  return out;
}

module.exports = {
  crossCheckInjuries,
  _normName,
  _lastName,
  _firstInitial,
  THIN_ROSTER_THRESHOLD,
};
