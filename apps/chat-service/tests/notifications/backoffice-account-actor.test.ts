/**
 * Account ban/suspend/unban/update rows come from a Super Admin in Backoffice.
 * Rows written before the producers stopped sending it carry the admin's id as
 * the actor; the serializer must never surface it. A normal user actor on any
 * other type is untouched.
 */
import type { Notification } from "../../src/generated/prisma/index.js";
import { serializeNotification } from "../../src/lib/notification-serializer.js";

function row(over: Partial<Notification>): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId: "",
    entity: {},
    actorSnapshot: {},
    payload: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-10-06T10:00:00Z"),
    updatedAt: new Date("2026-10-06T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type: "admin.user_banned",
    ...over,
  } as Notification;
}

describe("Backoffice account notifications hide the Super Admin", () => {
  it.each([
    "admin.user_banned",
    "admin.user_suspended",
    "admin.user_unbanned",
    "admin.user_account_updated",
  ])("%s: legacy admin id never reaches actor or payload", async (type) => {
    const dto = await serializeNotification(
      row({
        type,
        actorId: "admin-uuid-1",
        payload: {
          title: "Account",
          body: "Your account was updated",
          data: { actorId: "admin-uuid-1", reason: "spam" },
        },
      }),
      "viewer-1"
    );
    expect(JSON.stringify(dto)).not.toContain("admin-uuid-1");
    expect((dto as { actor?: unknown }).actor).toBeUndefined();
  });

  it("an app user's actor on another type is kept", async () => {
    const dto = await serializeNotification(
      row({
        type: "friend.request_received",
        actorId: "user-7",
        payload: { title: "", body: "Rajesh sent you a request", data: {} },
      }),
      "viewer-1"
    );
    expect((dto as { actor?: { id: string } }).actor?.id).toBe("user-7");
  });
});
