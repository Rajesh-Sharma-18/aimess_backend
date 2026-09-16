-- Account-level "@all mentions" push toggle. DEFAULT true keeps every existing
-- row receiving @all pushes, so no backfill is needed.
ALTER TABLE "notification_settings" ADD COLUMN "mentionAllEnabled" BOOLEAN NOT NULL DEFAULT true;
