/**
 * AIMESS-72: rows written before replay tickets existed (English prose, no `data.copyRef`) must still
 * read in the viewer's language, rebuilt from type + stored ids + the names resolved now. A row
 * missing the names its sentence needs keeps its stored text; authored rows are never touched.
 */
import { t } from "@aimess/constants";

import type { Notification } from "../../src/generated/prisma/index.js";
import {
  serializeNotification,
  type AvatarRefreshMaps,
} from "../../src/lib/notification-serializer.js";

function row(type: string, payload: unknown, actorId = "peer-1"): Notification {
  return {
    id: "n1",
    userId: "viewer-1",
    actorId,
    entity: {},
    actorSnapshot: {},
    isRead: false,
    readAt: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-01T10:00:00Z"),
    updatedAt: new Date("2026-08-01T10:00:00Z"),
    loginSessionId: null,
    loginExpiresAt: null,
    loginResolvedAt: null,
    groupKey: null,
    version: 1,
    type,
    payload,
  } as unknown as Notification;
}

const refresh: AvatarRefreshMaps = {
  actorById: new Map([["peer-1", { displayName: "Smiley Creatures", avatarUrl: "" }]]),
  communityById: new Map([["c1", { name: "Mission AIMESS" }]]),
};

describe("legacy notification rows follow the viewer's language (AIMESS-72)", () => {
  it("friend accepted: re-rendered in VI with the actor's current name", async () => {
    const dto = await serializeNotification(
      row("friend.accepted", {
        title: "Friend request accepted",
        body: "Your friend request was accepted.",
        data: { friendshipId: "f1", addresseeId: "peer-1" },
      }),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.body).toBe(
      t("NOTIF_FRIEND_ACCEPTED_FOR_REQUESTER", "vi", { name: "Smiley Creatures" })
    );
    expect(dto.templateId).toBe("friend.acceptedForRequester");
  });

  it("login detected with no stored data: VI title and body", async () => {
    const dto = await serializeNotification(
      row("auth.security_new_login", { title: "Login Detected", body: "New login detected.", data: {} }, ""),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.payload.title).toBe(t("NOTIF_AUTH_LOGIN_DETECTED_TITLE", "vi"));
    expect(dto.body).not.toContain("New login");
  });

  it("community row resolves the community name from the fresh lookup", async () => {
    const dto = await serializeNotification(
      row("community.member_unmuted", {
        title: "You have been unmuted",
        body: "You can post in the community again.",
        data: { communityId: "c1" },
      }),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.body).toContain("Mission AIMESS");
    expect(dto.body).not.toBe("You can post in the community again.");
  });

  it("keeps the stored text when the names the sentence needs are unknown", async () => {
    const dto = await serializeNotification(
      row("community.member_unmuted", {
        title: "You have been unmuted",
        body: "You can post in the community again.",
        data: { communityId: "unknown" },
      }),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.body).toBe("You can post in the community again.");
    expect(dto.templateId).toBeUndefined();
  });

  it("account banned: VI sentence without the legacy reason code", async () => {
    const dto = await serializeNotification(
      row("admin.user_banned", { title: "Account banned", body: "Your account has been banned.", data: { reason: "OTHER" } }, ""),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.payload.title).toBe(t("NOTIF_ACCOUNT_BANNED_TITLE", "vi"));
    expect(dto.body).not.toContain("OTHER");
  });

  it("never re-renders authored rows", async () => {
    const dto = await serializeNotification(
      row("ANNOUNCEMENT", { title: "Maintenance", body: "We are upgrading.", data: {} }, ""),
      "viewer-1",
      refresh,
      "vi"
    );
    expect(dto.body).toBe("We are upgrading.");
  });
});
