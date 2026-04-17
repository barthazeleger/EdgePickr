'use strict';

function detectApiSportsFamily(host = '') {
  const h = String(host || '').toLowerCase();
  if (h.includes('american-football')) return 'american-football';
  if (h.includes('football')) return 'football';
  if (h.includes('basketball')) return 'basketball';
  if (h.includes('hockey')) return 'hockey';
  if (h.includes('baseball')) return 'baseball';
  if (h.includes('handball')) return 'handball';
  return 'unknown';
}

function supportsApiSportsInjuries(host) {
  const family = detectApiSportsFamily(host);
  return family === 'football' || family === 'american-football';
}

module.exports = {
  detectApiSportsFamily,
  supportsApiSportsInjuries,
};
