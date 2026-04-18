'use strict';

/**
 * v11.3.23 · Phase 7.1 · H3 · Centralized error-response helper.
 *
 * Reviewer Codex #2 vond dat admin/observability paden `e.message` lekken
 * via `res.status(500).json({ error: e.message })`. Dat is information
 * disclosure — ook als de caller admin is, is het onnodig en inconsistent
 * met de security-story elders.
 *
 * Deze helper logt de echte fout server-side en stuurt altijd een generieke
 * error-body naar de client.
 *
 * @param {import('express').Response} res
 * @param {Error|any} err   de gevangen error
 * @param {string} [tag]    optionele log-tag voor traceability
 * @param {string} [userMsg] optionele custom user-facing boodschap
 */
function sendInternalError(res, err, tag = 'internal', userMsg = 'Interne fout · check server logs') {
  const msg = (err && err.message) || String(err || 'unknown');
  console.error(`[${tag}]`, msg);
  if (err && err.stack) console.error(err.stack);
  return res.status(500).json({ error: userMsg });
}

module.exports = { sendInternalError };
