-- v15.4.4 · Late doctrine-fix voor v10.10.22 (Codex P0 finding).
-- Code in server.js::loadPushSubs verwacht `user_id` kolom op push_subscriptions
-- om sendPushToUser per-user te kunnen filteren (anti cross-user data-leak).
-- De code-fix landde in v10.10.22 maar de migratie nooit, waardoor
-- sendPushToUser sinds v10.10.22 stille no-op was (filter op undefined === uuid).
-- Voor single-operator EdgePickr functioneel verschil minimaal (sendPushToAll
-- werkt nog), maar doctrine-correct + future-proof voor multi-user.

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN push_subscriptions.user_id IS
  'v15.4.4: User-uuid die deze subscription bezit. NULL = legacy (pre-v10.10.22) of admin/global. sendPushToUser routes alleen naar matching user_id (plus NULL-fallback voor backwards-compat).';
