/**
 * push.service.ts — verifies skipInbox, the settings/quiet-hours gate and its
 * push-vs-inbox split, the non-suppressible security types, and that non-ACTIVE
 * community members are blocked from community FCM/inbox pushes (fail-closed
 * membership gate).
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(async () => ["token-1"]),
    deleteByToken: jest.fn(async () => undefined),
    touchLastSeen: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ invalidToken: false })),
}));
const mockChatNotificationClient = { createNotification: jest.fn() };
const mockUserSettingsClient = { getNotificationSettings: jest.fn() };
jest.mock("../../src/grpc/chat-notification.client.js", () => ({
  createChatNotificationClient: () => mockChatNotificationClient,
}));
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: () => mockUserSettingsClient,
}));

import {
  AdminUserEvents,
  AuthEvents,
  CommunityEvents,
} from "@aimess/shared-types";

import { communityClient } from "../../src/grpc/community.client.js";
import { pushToUser } from "../../src/services/push.service.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";

const chatNotificationClient = mockChatNotificationClient;
const userSettingsClient = mockUserSettingsClient;
const send = sendPush as unknown as jest.Mock;
const checkPref = communityClient.checkCommunityNotificationPref as jest.Mock;
const checkMembership = communityClient.checkCommunityMembership as jest.Mock;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const COMMUNITY_ID = "a".repeat(24);

beforeEach(() => {
  jest.clearAllMocks();
  userSettingsClient.getNotificationSettings.mockResolvedValue({
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
  });
  send.mockResolvedValue({ invalidToken: false });
  checkPref.mockResolvedValue({ enabled: true });
  checkMembership.mockResolvedValue({
    isMember: true,
    isBanned: false,
    status: "ACTIVE",
    role: "MEMBER",
  });
});

describe("pushToUser — skipInbox", () => {
  it("skips CreateNotification but still sends FCM when skipInbox=true", async () => {
    await pushToUser({
      userId: USER_ID,
      category: "chatEnabled",
      type: "MESSAGE",
      title: "Jane",
      body: "Hi!",
      skipInbox: true,
    });

    expect(chatNotificationClient.createNotification).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("writes the inbox row when skipInbox is omitted (business events)", async () => {
    await pushToUser({
      userId: USER_ID,
      category: "friendRequestEnabled",
      type: "friend.requested",
      title: "New friend request",
      body: "Jane sent you a friend request.",
    });

    expect(chatNotificationClient.createNotification).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("pushToUser — the settings gate", () => {
  const withSettings = (over: Record<string, unknown>) => {
    userSettingsClient.getNotificationSettings.mockResolvedValue({
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
      ...over,
    });
  };

  const friendRequest = {
    userId: USER_ID,
    category: "friendRequestEnabled" as const,
    type: "friend.requested",
    title: "New friend request",
    body: "Jane sent you a friend request.",
  };

  it("category OFF suppresses the push AND the inbox row", async () => {
    withSettings({ friendRequestEnabled: false });

    await pushToUser(friendRequest);

    expect(chatNotificationClient.createNotification).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("quiet hours suppresses the push but KEEPS the inbox row", async () => {
    // A window covering the whole day, so the test never depends on the clock.
    withSettings({
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
      timezone: "UTC",
    });

    await pushToUser(friendRequest);

    expect(chatNotificationClient.createNotification).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("a call rings through quiet hours", async () => {
    withSettings({
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
      timezone: "UTC",
    });

    await pushToUser({
      userId: USER_ID,
      category: "callEnabled",
      type: "CALL_INCOMING",
      title: "Jane",
      body: "Incoming call",
      skipInbox: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a security alert is delivered even with System off and quiet hours on", async () => {
    withSettings({
      systemEnabled: false,
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
      timezone: "UTC",
    });

    await pushToUser({
      userId: USER_ID,
      category: "systemEnabled",
      type: AuthEvents.SECURITY_NEW_LOGIN,
      title: "Login Detected",
      body: "New login on Chrome.",
    });

    expect(chatNotificationClient.createNotification).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("an admin ban is delivered even with System off — it is not an opt-in", async () => {
    withSettings({ systemEnabled: false });

    await pushToUser({
      userId: USER_ID,
      category: "systemEnabled",
      type: AdminUserEvents.USER_BANNED,
      title: "Account banned",
      body: "Your account has been banned.",
    });

    expect(chatNotificationClient.createNotification).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("an announcement IS suppressible — the System toggle is what it is for", async () => {
    withSettings({ systemEnabled: false });

    await pushToUser({
      userId: USER_ID,
      category: "systemEnabled",
      type: "ANNOUNCEMENT",
      title: "Scheduled maintenance",
      body: "We will be down at 02:00.",
    });

    expect(chatNotificationClient.createNotification).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("showPreview=false masks the pushed body but not the stored inbox row", async () => {
    withSettings({ showPreview: false });

    await pushToUser({
      userId: USER_ID,
      category: "friendRequestEnabled",
      type: "friend.requested",
      title: "New friend request",
      body: "Jane sent you a friend request.",
      showPreviewOverride: "New notification",
    });

    expect(chatNotificationClient.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Jane sent you a friend request." })
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ body: "New notification" })
    );
  });
});

describe("pushToUser — NOTIFY_SUPPRESSED_TYPES", () => {
  // MEMBER_KICKED and DELETED used to sit in NOTIFY_SUPPRESSED_TYPES, which
  // hard-returned before the gate and made their producers' bypassSettings
  // flags dead code — a kicked user got no push, no inbox row and no socket
  // event. They are now delivered like their sibling MEMBER_BANNED.
  it.each([CommunityEvents.MEMBER_KICKED, CommunityEvents.DELETED])(
    "delivers %s to the inbox and to FCM",
    async (type) => {
      await pushToUser({
        userId: USER_ID,
        category: "communityEnabled",
        type,
        title: "x",
        body: "y",
        // Producers pass this: the recipient is by definition no longer an
        // ACTIVE member, so the membership gate has to be skipped.
        bypassSettings: true,
      });

      expect(chatNotificationClient.createNotification).toHaveBeenCalledTimes(
        1
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    CommunityEvents.JOIN_REQUEST_REJECTED,
    CommunityEvents.MEMBER_UNBANNED,
    CommunityEvents.LIVESTREAM_STARTED,
  ])("no longer suppresses %s — push still fires", async (type) => {
    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type,
      title: "x",
      body: "y",
    });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("pushToUser — ACTIVE community membership gate", () => {
  it("suppresses FCM when recipient is not an ACTIVE member", async () => {
    checkMembership.mockResolvedValue({
      isMember: false,
      isBanned: false,
      status: "LEFT",
      role: "",
    });

    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type: "MESSAGE",
      title: "Community",
      body: "Hi!",
      skipInbox: true,
      communityPrefField: "chatEnabled",
      data: { communityId: COMMUNITY_ID },
    });

    expect(checkMembership).toHaveBeenCalledWith({
      communityId: COMMUNITY_ID,
      userId: USER_ID,
    });
    expect(checkPref).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses FCM when membership oracle throws (fail-closed)", async () => {
    checkMembership.mockRejectedValue(new Error("gRPC down"));

    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type: "MESSAGE",
      title: "Community",
      body: "Hi!",
      skipInbox: true,
      communityPrefField: "chatEnabled",
      data: { communityId: COMMUNITY_ID },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("still sends FCM for ACTIVE members when prefs allow", async () => {
    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type: "MESSAGE",
      title: "Community",
      body: "Hi!",
      skipInbox: true,
      communityPrefField: "chatEnabled",
      data: { communityId: COMMUNITY_ID },
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    CommunityEvents.INVITE_SENT,
    CommunityEvents.JOIN_REQUEST_REJECTED,
    CommunityEvents.MEMBER_UNBANNED,
  ])("skips the membership gate for lifecycle type %s", async (type) => {
    checkMembership.mockResolvedValue({
      isMember: false,
      isBanned: false,
      status: "LEFT",
      role: "",
    });

    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type,
      title: "x",
      body: "y",
      data: { communityId: COMMUNITY_ID },
    });

    expect(checkMembership).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
