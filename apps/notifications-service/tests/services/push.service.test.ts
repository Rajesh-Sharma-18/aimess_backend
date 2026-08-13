/**
 * push.service.ts — verifies skipInbox, NOTIFY_SUPPRESSED_TYPES, and that
 * non-ACTIVE community members are blocked from community FCM/inbox pushes
 * (fail-closed membership gate).
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

import { CommunityEvents } from "@aimess/shared-types";

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
