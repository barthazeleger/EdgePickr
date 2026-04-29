'use strict';

/**
 * v15.0.12 · Venue-effect signal (TSDB lookupvenue.php).
 *
 * Pure helper. Mapt een venue-object (TSDB lookupvenue) naar een soft OU-nudge.
 * Twee factoren:
 *   - Altitude: hoge stadions (>1500m) verhogen historisch goal-totalen door
 *     fysieke vermoeidheid van bezoekers (Denver, La Paz, Quito patroon).
 *   - Capacity: indicator voor crowd-density / home-advantage. Marginaal
 *     positief op overP via tempo/refereebias-mechanisme.
 *
 * Geen fetch — caller geeft venue-object van `getVenueDetails`. Returnt null
 * als beide factoren ontbreken zodat caller de signal kan skippen.
 *
 * Cap: ±2pp prob-nudge totaal zodat signal nooit overheerst.
 */

const ALTITUDE_THRESHOLD_M = 1500;
const ALTITUDE_PER_KM_NUDGE = 0.008;     // +0.8pp per km boven 1.5km, capped
const CAPACITY_REFERENCE = 40000;        // gemiddelde top-tier stadion capaciteit
const CAPACITY_FACTOR = 0.0006;          // pp per 1k boven referentie, capped
const SIGNAL_MAGNITUDE_CAP = 0.02;       // ±2pp totaal

/**
 * @param {object} venue - {altitudeM, capacity, name, city, country, ...}
 * @returns {null | {nudge, signal, factors}}
 */
function computeVenueEffect(venue) {
  if (!venue || typeof venue !== 'object') return null;

  const altitudeRaw = Number(venue.altitudeM ?? venue.altitude_m ?? venue.altitude);
  const capacityRaw = Number(venue.capacity);

  const factors = {};
  let nudge = 0;

  if (Number.isFinite(altitudeRaw) && altitudeRaw > 0) {
    if (altitudeRaw >= ALTITUDE_THRESHOLD_M) {
      const km = (altitudeRaw - ALTITUDE_THRESHOLD_M) / 1000;
      const altNudge = Math.min(0.012, km * ALTITUDE_PER_KM_NUDGE);
      nudge += altNudge;
      factors.altitude = { metres: altitudeRaw, nudge: +altNudge.toFixed(4) };
    }
  }

  if (Number.isFinite(capacityRaw) && capacityRaw > 0) {
    const delta = (capacityRaw - CAPACITY_REFERENCE) / 1000;
    const capNudge = Math.max(-0.005, Math.min(0.005, delta * CAPACITY_FACTOR));
    if (Math.abs(capNudge) >= 0.001) {
      nudge += capNudge;
      factors.capacity = { value: capacityRaw, nudge: +capNudge.toFixed(4) };
    }
  }

  if (Object.keys(factors).length === 0) return null;

  nudge = Math.max(-SIGNAL_MAGNITUDE_CAP, Math.min(SIGNAL_MAGNITUDE_CAP, nudge));
  const nudgePct = +(nudge * 100).toFixed(2);

  // Signal-naam bevat "over" + "under" zodat picks.js OU-relevantSignals filter
  // (regel 169-174) het signaal pakt voor zowel Over als Under markets.
  return {
    nudge,
    factors,
    signal: `venue_over_under:${nudgePct >= 0 ? '+' : ''}${nudgePct.toFixed(2)}%`,
  };
}

module.exports = {
  computeVenueEffect,
  ALTITUDE_THRESHOLD_M,
  CAPACITY_REFERENCE,
  SIGNAL_MAGNITUDE_CAP,
};
