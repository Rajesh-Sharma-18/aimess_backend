-- Canonical "Default message timer for new private chats".
--
-- The legacy `autoDeleteTimer` enum (OFF/DAYS_7/DAYS_15/DAYS_30) is kept and
-- still written, so existing clients are untouched. These columns hold the same
-- decision in the units the per-conversation policy actually uses, which is
-- what lets a new private room snapshot the value without a lossy enum mapping
-- — and what removes the DAYS_15 preset that existed nowhere else in the
-- product.
--
-- Defaults match the legacy default (OFF), and `autoDeleteDefaultVersion = 0`
-- marks every existing row as "never explicitly set", so the dual-read in
-- chat-service keeps honouring the legacy enum until the user saves once.
-- No backfill, no data loss, no rewrite of existing rows.
ALTER TABLE "chat_settings"
  ADD COLUMN "autoDeleteDefaultMode" TEXT NOT NULL DEFAULT 'OFF',
  ADD COLUMN "autoDeleteDefaultTtlSeconds" INTEGER,
  ADD COLUMN "autoDeleteDefaultVersion" INTEGER NOT NULL DEFAULT 0;
