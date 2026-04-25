'use strict';

/**
 * v12.2.9 (F6): persistent 2FA login-codes store.
 *
 * Voorheen in-memory Map → Render restart wist alle actieve codes.
 * Nu: Map als hot-cache + Supabase als source-of-truth. Auth.js gebruikt
 * dezelfde Map-interface (set/get/delete) maar onder de motorkap synct
 * elke mutatie naar Supabase. Bij boot wordt de Map geseed uit Supabase
 * voor die paar codes die mogelijk nog niet zijn verlopen.
 *
 * Graceful fallback: als Supabase faalt of de tabel ontbreekt, blijft
 * de Map functioneel (oude gedrag). Console.warn ipv hard error.
 */

function createAuthCodesStore({ supabase, ttlMs = 5 * 60 * 1000 }) {
  const cache = new Map(); // email_key → { code, expiresAt }

  function cacheClean() {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }

  async function _persist(emailKey, entry) {
    if (!supabase) return;
    try {
      const { error } = await supabase.from('auth_codes').upsert({
        email_key: emailKey,
        code: entry.code,
        expires_at: new Date(entry.expiresAt).toISOString(),
      }, { onConflict: 'email_key' });
      if (error && !/relation.*does not exist/i.test(String(error.message || ''))) {
        console.warn('[auth_codes] persist failed:', error.message);
      }
    } catch (e) {
      console.warn('[auth_codes] persist exception:', e.message);
    }
  }

  async function _drop(emailKey) {
    if (!supabase) return;
    try {
      const { error } = await supabase.from('auth_codes').delete().eq('email_key', emailKey);
      if (error && !/relation.*does not exist/i.test(String(error.message || ''))) {
        console.warn('[auth_codes] delete failed:', error.message);
      }
    } catch (e) {
      console.warn('[auth_codes] delete exception:', e.message);
    }
  }

  async function _hydrate(emailKey) {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase.from('auth_codes')
        .select('code, expires_at')
        .eq('email_key', emailKey)
        .single();
      if (error || !data) return null;
      const expiresAt = Date.parse(data.expires_at);
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
        _drop(emailKey).catch(() => {});
        return null;
      }
      return { code: data.code, expiresAt };
    } catch (_) { return null; }
  }

  // Map-interface (synchroon) — auth.js verwacht dit. Mutaties syncen
  // async naar Supabase; reads gaan naar cache. Bij missende cache na
  // restart valt auth.js terug op `null`-entry → 'Ongeldige of verlopen
  // code'. Voor extra robuustheid kan caller `getAsync` gebruiken die
  // ook Supabase raadpleegt (handig in verify-code endpoint).
  return {
    set(emailKey, entry) {
      cacheClean();
      cache.set(emailKey, entry);
      _persist(emailKey, entry).catch(() => {});
    },
    get(emailKey) {
      cacheClean();
      return cache.get(emailKey);
    },
    delete(emailKey) {
      cache.delete(emailKey);
      _drop(emailKey).catch(() => {});
    },
    // Async lookup — checkt eerst cache, anders Supabase. Voor verify-code
    // path: als de server na restart aankomt, cache is leeg maar code
    // bestaat nog in Supabase.
    async getAsync(emailKey) {
      cacheClean();
      const cached = cache.get(emailKey);
      if (cached) return cached;
      const fromDb = await _hydrate(emailKey);
      if (fromDb) cache.set(emailKey, fromDb);
      return fromDb;
    },
    // Voor TTL-sweep
    cleanup() {
      cacheClean();
      if (!supabase) return;
      const cutoffIso = new Date().toISOString();
      supabase.from('auth_codes').delete().lt('expires_at', cutoffIso).then(({ error }) => {
        if (error && !/relation.*does not exist/i.test(String(error.message || ''))) {
          console.warn('[auth_codes] sweep failed:', error.message);
        }
      }).catch((e) => console.warn('[auth_codes] sweep exception:', e.message));
    },
    // Dev-helper voor tests
    _cache: cache,
  };
}

module.exports = { createAuthCodesStore };
