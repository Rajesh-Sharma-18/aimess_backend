import type { NotificationSettingsRow } from "../repositories/user-settings.repository.js";

/**
 * NotificationSettings row → user.proto `NotificationSettings`. When no row
 * exists yet, default to "all enabled" so notifications-service still delivers
 * (allow-by-default). Kept out of server.ts so it is unit-testable (server.ts
 * proto-loads via `import.meta.url`, which CJS-mode Jest cannot import).
 */
export function toNotificationSettingsWire(
  row: NotificationSettingsRow | null,
  language: string
) {
  return {
    language,
    chatEnabled: row?.chatEnabled ?? true,
    callEnabled: row?.callEnabled ?? true,
    friendRequestEnabled: row?.friendRequestEnabled ?? true,
    systemEnabled: row?.systemEnabled ?? true,
    communityEnabled: row?.communityEnabled ?? true,
    liveStreamEnabled: row?.liveStreamEnabled ?? true,
    showPreview: row?.showPreview ?? true,
    // Inverted on the wire so proto3's default false means "receive".
    mentionAllMuted: row ? row.mentionAllEnabled === false : false,
    quietHoursEnabled: row?.quietHoursEnabled ?? false,
    quietHoursStart: row?.quietHoursStart ?? "",
    quietHoursEnd: row?.quietHoursEnd ?? "",
    quietHoursDays: row?.quietHoursDays ?? [],
    // "" tells notifications-service to evaluate in server-local time,
    // which is what every row did before the column existed.
    timezone: row?.quietHoursTimezone ?? "",
  };
}
