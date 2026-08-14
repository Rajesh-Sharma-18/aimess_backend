-- Quiet hours were evaluated in server-local time, so a 22:00-07:00 window set
-- by a Bangkok user was applied at the server's 22:00. NULL keeps that exact
-- behaviour for every existing row, so no backfill is needed — clients start
-- sending their IANA zone and each row self-heals on its next settings write.
ALTER TABLE "notification_settings" ADD COLUMN "quietHoursTimezone" TEXT;
