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
// The real module pulls in auth-session.client, which proto-loads via
// `import.meta.url` and cannot be parsed by CJS-mode Jest.
jest.mock("../../src/lib/session-active-cache.js", () => ({
  isSessionActiveForRequest: jest.fn(async () => true),
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

const send = sendPush as unknown as jest.Mock;
const USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  jest.clearAllMocks();
  // Every toggle off: mandatory types must still be delivered.
  mockUserSettingsClient.getNotificationSettings.mockResolvedValue({
    chatEnabled: false,
    callEnabled: false,
    friendRequestEnabled: false,
    systemEnabled: false,
    communityEnabled: false,
    liveStreamEnabled: false,
    showPreview: true,
    quietHoursEnabled: false,
    quietHoursStart: "",
    quietHoursEnd: "",
    quietHoursDays: [],
    timezone: "",
  });
  send.mockResolvedValue({ invalidToken: false });
  (communityClient.checkCommunityNotificationPref as jest.Mock).mockResolvedValue({ enabled: false });
  (communityClient.checkCommunityMembership as jest.Mock).mockResolvedValue({
    isMember: true,
    isBanned: false,
    status: "ACTIVE",
    role: "MEMBER",
  });
});

describe("pushToUser — mandatory System-channel types", () => {
  it.each([
    ["REPORT_OUTCOME", "systemEnabled", {}, 1],
    ["ACCOUNT_WARNED", "systemEnabled", {}, 1],
    [CommunityEvents.MEMBER_MUTED, "communityEnabled", { communityId: "c1" }, 0],
    ["COMMUNITY_ADMIN_INACTIVE_REMINDER", "communityEnabled", { communityId: "c1" }, 1],
  ] as const)("%s bypasses toggles and rides channelId system_v2", async (type, category, data, inboxRows) => {
    await pushToUser({
      userId: USER_ID,
      category,
      type,
      title: "t",
      body: "b",
      data: { ...data },
    });

    expect(mockChatNotificationClient.createNotification).toHaveBeenCalledTimes(inboxRows);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].data.channelId).toBe("system_v2");
  });

  it("a non-mandatory type stays gated and untagged", async () => {
    await pushToUser({
      userId: USER_ID,
      category: "friendRequestEnabled",
      type: "friend.requested",
      title: "t",
      body: "b",
    });

    expect(send).not.toHaveBeenCalled();
  });
});
