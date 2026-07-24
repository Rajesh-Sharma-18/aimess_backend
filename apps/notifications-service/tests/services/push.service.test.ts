/**
 * push.service.ts — verifies the `skipInbox` flag (Notification Center is
 * business-events-only; chat-activity pushes must skip the inbox write but
 * still send FCM), that `NOTIFY_SUPPRESSED_TYPES` no longer swallows
 * JOIN_REQUEST_REJECTED / MEMBER_UNBANNED / LIVESTREAM_STARTED, and that
 * non-ACTIVE community members are blocked from community FCM/inbox pushes.
 */
jest.mock("../../src/repositories/device-token.repository.js", () => ({
  deviceTokenRepository: {
    findTokensByUserId: jest.fn(async () => ["token-1"]),
    deleteByToken: jest.fn(async () => undefined),
  },
}));
jest.mock("../../src/providers/firebase/sendPush.js", () => ({
  sendPush: jest.fn(async () => ({ invalidToken: false })),
}));
// Override the global factory mocks with SINGLETONS — push.service.ts calls
// `createChatNotificationClient()`/`createUserSettingsClient()` once at
// module load, so a factory returning a fresh object per call (the global
// default) would leave this test asserting on a different mock instance.
const mockChatNotificationClient = { createNotification: jest.fn() };
const mockUserSettingsClient = { getNotificationSettings: jest.fn() };
jest.mock("../../src/grpc/chat-notification.client.js", () => ({
  createChatNotificationClient: () => mockChatNotificationClient,
}));
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: () => mockUserSettingsClient,
}));

import { CommunityEvents } from "@aimess/shared-types";

import { communityClient } from "../../src/grpc/community.client.js";
import { pushToUser } from "../../src/services/push.service.js";
import { sendPush } from "../../src/providers/firebase/sendPush.js";

const chatNotificationClient = mockChatNotificationClient;
const userSettingsClient = mockUserSettingsClient;
const send = sendPush as unknown as jest.Mock;
const checkPref = communityClient.checkCommunityNotificationPref as jest.Mock;

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
  });
  send.mockResolvedValue({ invalidToken: false });
  checkPref.mockResolvedValue({ enabled: true });
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

describe("pushToUser — NOTIFY_SUPPRESSED_TYPES", () => {
  it("still fully suppresses MEMBER_KICKED (inbox + push)", async () => {
    await pushToUser({
      userId: USER_ID,
      category: "communityEnabled",
      type: CommunityEvents.MEMBER_KICKED,
      title: "x",
      body: "y",
    });

    expect(chatNotificationClient.createNotification).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    CommunityEvents.JOIN_REQUEST_REJECTED,
    CommunityEvents.MEMBER_UNBANNED,
    CommunityEvents.LIVESTREAM_STARTED,
  ])(
    "no longer suppresses %s — push still fires (Notification Center requirement)",
    async (type) => {
      await pushToUser({
        userId: USER_ID,
        category: "communityEnabled",
        type,
        title: "x",
        body: "y",
      });

      expect(send).toHaveBeenCalledTimes(1);
    }
  );
});

describe("pushToUser — ACTIVE community membership gate", () => {
  it("suppresses FCM when the community pref/membership oracle returns enabled=false", async () => {
    checkPref.mockResolvedValue({ enabled: false });

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

    expect(checkPref).toHaveBeenCalledWith({
      communityId: COMMUNITY_ID,
      userId: USER_ID,
      field: "chatEnabled",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("still sends FCM for ACTIVE members when oracle returns enabled=true", async () => {
    checkPref.mockResolvedValue({ enabled: true });

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
  ])(
    "skips the membership gate for lifecycle type %s (non-member recipient)",
    async (type) => {
      checkPref.mockResolvedValue({ enabled: false });

      await pushToUser({
        userId: USER_ID,
        category: "communityEnabled",
        type,
        title: "x",
        body: "y",
        data: { communityId: COMMUNITY_ID },
      });

      expect(checkPref).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    }
  );
});
