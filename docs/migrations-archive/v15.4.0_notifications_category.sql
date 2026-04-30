-- v15.4 · Operator-inbox category-tag (PLAN §6).
-- Voegt een `category` kolom toe aan `notifications` zodat de inbox-UI
-- en lib/notifications.js kunnen filteren op de 8 canonical operator-
-- categorieën (operator_action, phase_progress, auto_promotion,
-- auto_demotion, unit_change, red_flag, coverage_insight, data_source_audit).
-- Bestaande rijen blijven NULL → tonen onder "Alles" in de inbox totdat
-- nieuwe rijen met category-tag zijn ingelogd.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_category_unread
  ON notifications (category, created_at DESC)
  WHERE read = false;

COMMENT ON COLUMN notifications.category IS
  'v15.4: Operator-inbox category — operator_action / phase_progress / auto_promotion / auto_demotion / unit_change / red_flag / coverage_insight / data_source_audit. NULL = legacy/non-operator notification (laat default-routing).';
