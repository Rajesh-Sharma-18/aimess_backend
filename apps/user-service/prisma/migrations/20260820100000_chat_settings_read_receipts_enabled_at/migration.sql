-- Read receipts are a point-in-time policy, not a boolean applied to history.
--
-- While the switch is OFF the user gives no receipts and is shown none; turning
-- it back ON must not resurrect the ones withheld in between. This column
-- records the instant of the most recent OFF -> ON transition, and chat-service
-- hides every receipt stamped before it.
--
-- NULL = never disabled, which is every existing row: no backfill, and nobody
-- loses a receipt they can already see.
ALTER TABLE "chat_settings" ADD COLUMN "readReceiptsEnabledAt" TIMESTAMPTZ(3);
