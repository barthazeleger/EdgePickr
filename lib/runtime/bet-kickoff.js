'use strict';

/**
 * v11.3.23 Phase 7.1 · C2 · pure helper voor bet-kickoff timestamp berekening.
 *
 * Reviewer Codex #2 vond dat `schedulePreKickoffCheck` + `scheduleCLVCheck` de
 * huidige datum (`nowAms`) gebruikten i.p.v. `bet.datum` wanneer `bet.tijd` in
 * `HH:MM`-format was. Bets >1 dag vooruit werden verkeerd of helemaal niet
 * gepland.
 *
 * Deze helper neemt `bet.datum` ("DD-MM-YYYY") + `bet.tijd` ("HH:MM" of ISO)
 * en retourneert de kickoff-timestamp in ms (UTC), DST-correct voor
 * Europe/Amsterdam.
 *
 * @param {string} datum   "DD-MM-YYYY" — optioneel, fallback: vandaag Amsterdam.
 * @param {string} tijd    "HH:MM" (Amsterdam-lokaal) of ISO-string.
 * @returns {number|null}  kickoff in ms (UTC), of null als input invalide.
 */
function parseBetKickoff(datum, tijd) {
  if (!tijd || typeof tijd !== 'string') return null;

  // ISO path: direct parseable (yyyy-mm-dd of volledige ISO).
  if (tijd.includes('T') || tijd.includes('-')) {
    const t = new Date(tijd).getTime();
    return Number.isFinite(t) ? t : null;
  }

  // HH:MM path: resolve als Amsterdam-lokaal.
  const parts = tijd.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;

  let ymd;
  let datumProvided = false;
  if (datum && typeof datum === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(datum.trim())) {
    const [dd, mm, yyyy] = datum.trim().split('-');
    ymd = `${yyyy}-${mm}-${dd}`;
    datumProvided = true;
  } else {
    ymd = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  }

  // Construeer naïeve Amsterdam-lokale tijd, probe Amsterdam-offset op dat
  // moment (DST-aware), trek offset af om UTC-ms te krijgen.
  const naiveIso = `${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const naiveUtcMs = new Date(naiveIso + 'Z').getTime();
  if (!Number.isFinite(naiveUtcMs)) return null;

  const probe = new Date(naiveUtcMs);
  const probeUtcH = probe.getUTCHours();
  const probeAmsHStr = probe.toLocaleString('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam',
  });
  const probeAmsH = parseInt(probeAmsHStr, 10);
  if (!Number.isFinite(probeAmsH)) return null;

  let offsetHours = probeAmsH - probeUtcH;
  // Day-wrap correctie: Amsterdam kan op andere kalenderdag zitten dan UTC.
  if (offsetHours < -12) offsetHours += 24;
  if (offsetHours > 12) offsetHours -= 24;

  const kickoffMs = naiveUtcMs - offsetHours * 3600000;

  // Als datum NIET opgegeven en resultaat in het verleden ligt: add 1 dag.
  // Dit preserveert het oude gedrag voor bets zonder datum (legacy flow).
  if (!datumProvided && kickoffMs < Date.now()) {
    return kickoffMs + 86400000;
  }
  return kickoffMs;
}

module.exports = { parseBetKickoff };
