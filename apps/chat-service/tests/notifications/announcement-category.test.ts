/**
 * A Super-Admin announcement must be identifiable from the response alone.
 *
 * Announcement rows are stored with `type: "ANNOUNCEMENT"` and admin-AUTHORED
 * title/body, so a client that wants to draw the megaphone glyph had nothing
 * explicit to key on — it either matched the type string itself or, worse, the
 * prose. The serializer now reports `category: "Announcement"` on those rows,
 * and leaves every other row's tab category exactly as it was.
 */
import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";
import { categoryWhere } from "../../src/lib/notification-category.js";

function row(type: string): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId: "",
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-20T10:00:00Z"),
    updatedAt: new Date("2026-08-20T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type,
    payload: { title: "Scheduled maintenance", body: "We are upgrading." },
  } as unknown as Notification;
}

describe("announcement row category", () => {
  it("reports the explicit Announcement category", async () => {
    const dto = await serializeNotification(row("ANNOUNCEMENT"), "viewer-1");
    expect(dto.category).toBe("Announcement");
    expect(dto.type).toBe("ANNOUNCEMENT");
  });

  it("leaves every other row's category untouched", async () => {
    const cases: [string, string][] = [
      ["MAINTENANCE", "SYSTEM"],
      ["UPDATE_REQUIRED", "SYSTEM"],
      ["auth.security_new_login", "SYSTEM"],
      ["admin.user_banned", "SYSTEM"],
      ["friend.requested", "FRIENDS"],
      ["community.member_banned", "COMMUNITIES"],
      ["call.activity", "CALLS"],
      ["CALL_MISSED", "CALLS"],
    ];
    for (const [type, expected] of cases) {
      const dto = await serializeNotification(row(type), "viewer-1");
      expect(dto.category).toBe(expected);
    }
  });

  it("still lists and counts an announcement under the SYSTEM tab", () => {
    // The tab filter is keyed on `type`, never on the DTO's category string —
    // that is what keeps the new value from emptying the System tab.
    const where = categoryWhere("SYSTEM") as {
      OR: { type: { in?: string[] } }[];
    };
    expect(where.OR.some((c) => c.type.in?.includes("ANNOUNCEMENT"))).toBe(
      true
    );
  });
});
