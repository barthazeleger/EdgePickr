'use strict';

/**
 * v15.4 · Operator-inbox helper. PLAN §6 definieert de canonical categorieën;
 * dit module wraps Supabase-insert + optionele web-push zodat call-sites niet
 * over schema-tolerantie of push-routing hoeven na te denken.
 *
 * Categorieën:
 *   - operator_action     · "Doe X" — push-trigger, blokkeert geen scan
 *   - phase_progress      · wekelijkse "Pad A: N/200" voortgang
 *   - auto_promotion      · graduation events (bestaande types: expansion_graduation_ready)
 *   - auto_demotion       · drift-detector demotes (v15.6+)
 *   - unit_change         · v15.7 unit-controller real-time + pending
 *   - red_flag            · push-trigger: ROI/CLV onder drempel
 *   - coverage_insight    · v15.4 coverage-audit + dormant ligas
 *   - data_source_audit   · v15.7 per-endpoint ROI-audit
 *
 * Webpush-routing: alleen `operator_action` en `red_flag` triggeren push (zie
 * PLAN §6). Rest landt stil in inbox — voorkomt push-pump.
 *
 * Het schrijfpad valt automatisch terug op insert-zonder-`category` als de
 * Supabase-migratie nog niet is uitgevoerd; dat houdt de scheduler-flow live
 * tijdens een staged deploy. Schema-tolerant via column-error retry.
 */

const OPERATOR_CATEGORIES = Object.freeze([
  'operator_action',
  'phase_progress',
  'auto_promotion',
  'auto_demotion',
  'unit_change',
  'red_flag',
  'coverage_insight',
  'data_source_audit',
]);

const OPERATOR_PUSH_CATEGORIES = Object.freeze(new Set(['operator_action', 'red_flag']));

function isOperatorCategory(cat) {
  return typeof cat === 'string' && OPERATOR_CATEGORIES.includes(cat);
}

function shouldPushForCategory(cat) {
  return OPERATOR_PUSH_CATEGORIES.has(String(cat || ''));
}

function isColumnError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('column') && msg.includes('category');
}

/**
 * Schrijft een operator-notificatie naar de `notifications` tabel met de juiste
 * category-tag. Faalt schema-tolerant terug naar plain insert als de
 * `category` kolom (migratie v15.4) nog ontbreekt.
 *
 * Returns { ok: true, id?, fellBack? } of { ok: false, error }.
 *
 * @param {object} args
 *   - supabase   · Supabase client
 *   - category   · OPERATOR_CATEGORIES
 *   - type       · existing notification type (mapping naar inbox-icoon)
 *   - title      · short header
 *   - body       · body text (≤1500 chars)
 *   - userId     · null voor global, anders user-uuid
 *   - sendPush   · optional fn(category, title, body) → Promise · alleen
 *                  aangeroepen als shouldPushForCategory(category)
 */
async function sendOperatorNotification(args) {
  const { supabase, category, type, title, body, userId = null, sendPush = null } = args || {};
  if (!supabase || typeof supabase.from !== 'function') {
    return { ok: false, error: 'missing_supabase' };
  }
  if (!isOperatorCategory(category)) {
    return { ok: false, error: 'invalid_category' };
  }
  const safeBody = String(body || '').slice(0, 1500);
  const safeTitle = String(title || '').slice(0, 200);
  const safeType = String(type || category);

  const payload = {
    type: safeType,
    title: safeTitle,
    body: safeBody,
    read: false,
    user_id: userId,
    category,
  };

  let fellBack = false;
  let inserted = null;
  try {
    const { data, error } = await supabase.from('notifications').insert(payload).select('id').maybeSingle();
    if (error && isColumnError(error)) {
      // Pre-migratie schema — strip category en re-try.
      fellBack = true;
      const { category: _drop, ...legacy } = payload;
      const retry = await supabase.from('notifications').insert(legacy).select('id').maybeSingle();
      if (retry.error) return { ok: false, error: retry.error.message || 'insert_failed' };
      inserted = retry.data || null;
    } else if (error) {
      return { ok: false, error: error.message || 'insert_failed' };
    } else {
      inserted = data || null;
    }
  } catch (e) {
    return { ok: false, error: e.message || 'insert_threw' };
  }

  if (sendPush && shouldPushForCategory(category)) {
    try { await sendPush(category, safeTitle, safeBody); }
    catch (_) { /* push mag operator-flow nooit breken */ }
  }

  return { ok: true, id: inserted?.id || null, fellBack };
}

module.exports = {
  OPERATOR_CATEGORIES,
  OPERATOR_PUSH_CATEGORIES,
  isOperatorCategory,
  shouldPushForCategory,
  sendOperatorNotification,
};
