/**
 * Unit tests for the notification decision engine — the two pure functions
 * every push in the system passes through.
 *
 * These exist because the day-of-week filter shipped with the writer storing
 * 0=Sunday..6=Saturday and the reader comparing ISO 1=Mon..7=Sun. Mon-Sat
 * coincided, so the bug only ever showed up on Sundays and nothing caught it.
 *
 * No broker, no DB, no mocks beyond a settings literal.
 */
import { describe, expect, it } from "@jest/globals";

import {
  evaluateDelivery,
  isInQuietHours,
  type NotificationCategory,
} from "../../src/services/notification-settings.service.js";
import type { NotificationSettings } from "../../src/grpc/user-settings.client.js";

const ALL_ON: NotificationSettings = {
  chatEnabled: true,
  callEnabled: true,
  friendRequestEnabled: true,
  systemEnabled: true,
  communityEnabled: true,
  liveStreamEnabled: true,
  showPreview: true,
  quietHoursEnabled: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  quietHoursDays: [],
  timezone: "",
  language: "",
};

const settings = (
  over: Partial<NotificationSettings>
): NotificationSettings => ({
  ...ALL_ON,
  ...over,
});

/** A Date whose UTC wall-clock is the given local time — tests pin timezone explicitly. */
const utc = (iso: string): Date => new Date(`${iso}Z`);

const CATEGORIES: NotificationCategory[] = [
  "chatEnabled",
  "callEnabled",
  "friendRequestEnabled",
  "systemEnabled",
  "communityEnabled",
  "liveStreamEnabled",
];

describe("evaluateDelivery — category toggles", () => {
  it.each(CATEGORIES)("%s ON delivers", (category) => {
    expect(evaluateDelivery(ALL_ON, category)).toBe("ALLOW");
  });

  it.each(CATEGORIES)("%s OFF suppresses with CATEGORY_OFF", (category) => {
    expect(evaluateDelivery(settings({ [category]: false }), category)).toBe(
      "CATEGORY_OFF"
    );
  });

  it("one category OFF does not affect the others", () => {
    const only = settings({ chatEnabled: false });
    expect(evaluateDelivery(only, "chatEnabled")).toBe("CATEGORY_OFF");
    expect(evaluateDelivery(only, "communityEnabled")).toBe("ALLOW");
  });
});

describe("evaluateDelivery — quiet hours interaction", () => {
  const inWindow = settings({
    quietHoursEnabled: true,
    quietHoursStart: "00:00",
    quietHoursEnd: "23:59",
    timezone: "UTC",
  });

  it("returns QUIET_HOURS, NOT CATEGORY_OFF — the inbox row depends on the difference", () => {
    expect(evaluateDelivery(inWindow, "chatEnabled")).toBe("QUIET_HOURS");
  });

  it("calls ring through quiet hours", () => {
    expect(evaluateDelivery(inWindow, "callEnabled")).toBe("ALLOW");
    expect(evaluateDelivery(inWindow, "callEnabled", "CALL_INCOMING")).toBe(
      "ALLOW"
    );
  });

  it("quiet hours DO silence a missed-call alert — the call is already over", () => {
    expect(evaluateDelivery(inWindow, "callEnabled", "CALL_MISSED")).toBe(
      "QUIET_HOURS"
    );
  });

  it("but the call toggle itself still binds during quiet hours", () => {
    expect(
      evaluateDelivery({ ...inWindow, callEnabled: false }, "callEnabled")
    ).toBe("CATEGORY_OFF");
  });

  it("category OFF outranks quiet hours", () => {
    expect(
      evaluateDelivery({ ...inWindow, chatEnabled: false }, "chatEnabled")
    ).toBe("CATEGORY_OFF");
  });
});

describe("isInQuietHours — window arithmetic", () => {
  const window = (start: string, end: string, over = {}) =>
    settings({
      quietHoursEnabled: true,
      quietHoursStart: start,
      quietHoursEnd: end,
      timezone: "UTC",
      ...over,
    });

  it("disabled is never quiet, even with a window configured", () => {
    const s = window("22:00", "07:00");
    expect(
      isInQuietHours(
        { ...s, quietHoursEnabled: false },
        utc("2026-08-12T23:00")
      )
    ).toBe(false);
  });

  it("enabled with no window configured is never quiet", () => {
    expect(isInQuietHours(window("", ""), utc("2026-08-12T23:00"))).toBe(false);
  });

  it("same-day window: start inclusive, end exclusive", () => {
    const s = window("09:00", "17:00");
    expect(isInQuietHours(s, utc("2026-08-12T08:59"))).toBe(false);
    expect(isInQuietHours(s, utc("2026-08-12T09:00"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-12T16:59"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-12T17:00"))).toBe(false);
  });

  it("overnight window wraps past midnight", () => {
    const s = window("22:00", "07:00");
    expect(isInQuietHours(s, utc("2026-08-12T21:59"))).toBe(false);
    expect(isInQuietHours(s, utc("2026-08-12T22:00"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-12T23:59"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-13T00:00"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-13T06:59"))).toBe(true);
    expect(isInQuietHours(s, utc("2026-08-13T07:00"))).toBe(false);
  });

  it("start === end is a zero-length window, not an all-day one", () => {
    const s = window("22:00", "22:00");
    expect(isInQuietHours(s, utc("2026-08-12T22:00"))).toBe(false);
    expect(isInQuietHours(s, utc("2026-08-12T03:00"))).toBe(false);
  });

  it("a malformed stored time never silences anyone", () => {
    expect(
      isInQuietHours(window("25:00", "07:00"), utc("2026-08-12T23:00"))
    ).toBe(false);
  });
});

describe("isInQuietHours — day selection (0=Sunday .. 6=Saturday)", () => {
  // 2026-08-09 is a Sunday; the week runs Sun 09 .. Sat 15.
  const DAYS = [
    { day: 0, name: "Sunday", date: "2026-08-09" },
    { day: 1, name: "Monday", date: "2026-08-10" },
    { day: 2, name: "Tuesday", date: "2026-08-11" },
    { day: 3, name: "Wednesday", date: "2026-08-12" },
    { day: 4, name: "Thursday", date: "2026-08-13" },
    { day: 5, name: "Friday", date: "2026-08-14" },
    { day: 6, name: "Saturday", date: "2026-08-15" },
  ];

  const daily = settings({
    quietHoursEnabled: true,
    quietHoursStart: "09:00",
    quietHoursEnd: "17:00",
    timezone: "UTC",
  });

  it("empty days means every day", () => {
    for (const { date } of DAYS) {
      expect(isInQuietHours(daily, utc(`${date}T12:00`))).toBe(true);
    }
  });

  // The regression guard: with ISO numbering at the reader, day 0 matched
  // nothing and days 1..6 were compared against the right ISO number only by
  // coincidence — so Sunday silently never triggered.
  it.each(DAYS)(
    "day $day ($name) matches only its own date",
    ({ day, date }) => {
      const s = { ...daily, quietHoursDays: [day] };
      expect(isInQuietHours(s, utc(`${date}T12:00`))).toBe(true);

      for (const other of DAYS.filter((d) => d.day !== day)) {
        expect(isInQuietHours(s, utc(`${other.date}T12:00`))).toBe(false);
      }
    }
  );

  it("weekdays-only selection skips the weekend", () => {
    const s = { ...daily, quietHoursDays: [1, 2, 3, 4, 5] };
    expect(isInQuietHours(s, utc("2026-08-10T12:00"))).toBe(true); // Monday
    expect(isInQuietHours(s, utc("2026-08-09T12:00"))).toBe(false); // Sunday
    expect(isInQuietHours(s, utc("2026-08-15T12:00"))).toBe(false); // Saturday
  });
});

describe("isInQuietHours — timezone", () => {
  const bangkok = settings({
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    timezone: "Asia/Bangkok", // UTC+7, no DST
  });

  it("evaluates the window in the user's zone, not the server's", () => {
    // 16:00Z is 23:00 in Bangkok — inside a 22:00-07:00 window.
    expect(isInQuietHours(bangkok, utc("2026-08-12T16:00"))).toBe(true);
    // 12:00Z is 19:00 in Bangkok — outside it.
    expect(isInQuietHours(bangkok, utc("2026-08-12T12:00"))).toBe(false);
  });

  it("derives the weekday from the shifted date, not from UTC", () => {
    // 2026-08-09 is Sunday UTC, but 18:00Z that day is already Monday 01:00
    // in Bangkok. Selecting Monday must match; selecting Sunday must not.
    const at = utc("2026-08-09T18:00");
    expect(isInQuietHours({ ...bangkok, quietHoursDays: [1] }, at)).toBe(true);
    expect(isInQuietHours({ ...bangkok, quietHoursDays: [0] }, at)).toBe(false);
  });

  it("honours a DST shift rather than a fixed offset", () => {
    // New York is UTC-4 in August, UTC-5 in January. 02:00Z is 22:00 the
    // previous evening in summer but only 21:00 in winter.
    const ny = settings({
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/New_York",
    });
    expect(isInQuietHours(ny, utc("2026-08-12T02:00"))).toBe(true);
    expect(isInQuietHours(ny, utc("2026-01-12T02:00"))).toBe(false);
  });

  it("an unusable timezone falls back to server-local instead of throwing", () => {
    const broken = { ...bangkok, timezone: "Not/AZone" };
    expect(() => isInQuietHours(broken, utc("2026-08-12T16:00"))).not.toThrow();
  });
});
