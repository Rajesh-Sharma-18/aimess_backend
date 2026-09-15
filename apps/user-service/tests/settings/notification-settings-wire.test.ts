/**
 * GetNotificationSettings row → wire mapping (what the gRPC handler in
 * `src/grpc/server.ts` returns). `mentionAllMuted` is inverted on the wire so
 * proto3's default false means "receive @all pushes".
 */
import { toNotificationSettingsWire } from "../../src/grpc/notification-settings.wire.js";
import type { NotificationSettingsRow } from "../../src/repositories/user-settings.repository.js";

function row(overrides: Partial<NotificationSettingsRow> = {}): NotificationSettingsRow {
  return {
    chatEnabled: true,
    callEnabled: true,
    friendRequestEnabled: true,
    systemEnabled: true,
    communityEnabled: true,
    liveStreamEnabled: true,
    showPreview: true,
    mentionAllEnabled: true,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursDays: [],
    quietHoursTimezone: null,
    ...overrides,
  };
}

describe("toNotificationSettingsWire", () => {
  it("mentionAllMuted is true when @all mentions are disabled", () => {
    expect(
      toNotificationSettingsWire(row({ mentionAllEnabled: false }), "en")
        .mentionAllMuted
    ).toBe(true);
  });

  it("mentionAllMuted is false when @all mentions are enabled", () => {
    expect(toNotificationSettingsWire(row(), "en").mentionAllMuted).toBe(false);
  });

  it("row missing → allow-by-default, mentionAllMuted false", () => {
    const wire = toNotificationSettingsWire(null, "");
    expect(wire.mentionAllMuted).toBe(false);
    expect(wire.chatEnabled).toBe(true);
    expect(wire.showPreview).toBe(true);
    expect(wire.quietHoursEnabled).toBe(false);
    expect(wire.timezone).toBe("");
  });
});
